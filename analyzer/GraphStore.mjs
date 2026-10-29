/** Immutable, disk-sharded dataflow generations with a transactional publication pointer.
 * Edges are partitioned by monotonically assigned edge IDs. The on-disk catalog
 * maps event/variable adjacency to shards, including edges crossing event ranges.
 */
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { randomUUID, createHash } from 'crypto';
import * as db from './db/Database.mjs';
import { cfg } from './Config.mjs';

export const GRAPH_STORE_VERSION = 1;
const COLUMNS = 'id, from_event_id, to_event_id, from_var, to_var, edge_type, iid, line';
const EDGE_SCHEMA = `CREATE TABLE edges (
    id INTEGER PRIMARY KEY, from_event_id INTEGER, to_event_id INTEGER,
    from_var TEXT, to_var TEXT, edge_type TEXT NOT NULL, iid INTEGER, line INTEGER);
    CREATE INDEX edges_from_event ON edges(from_event_id,id);
    CREATE INDEX edges_to_event ON edges(to_event_id,id);
    CREATE INDEX edges_from_var ON edges(from_var,id);
    CREATE INDEX edges_to_var ON edges(to_var,id);
    CREATE INDEX edges_type ON edges(edge_type,id);`;

function positive(value, fallback) {
    const n = Number(value ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Graph limits must be positive integers');
    return n;
}
function configure(connection, writable = false) {
    connection.pragma('cache_size = -1024');
    connection.pragma('temp_store = FILE');
    connection.pragma('mmap_size = 0');
    if (writable) { connection.pragma('journal_mode = DELETE'); connection.pragma('synchronous = FULL'); }
}
function filters(options = {}) {
    const parts = [], args = [];
    if (options.edgeType) { parts.push('edge_type=?'); args.push(options.edgeType); }
    if (options.varExact) { parts.push('(from_var=? OR to_var=?)'); args.push(options.varExact, options.varExact); }
    else if (options.varName) { parts.push('(from_var LIKE ? OR to_var LIKE ?)'); args.push(`%${options.varName}%`, `%${options.varName}%`); }
    for (const [key, op] of [['seqFrom','>='],['seqTo','<=']]) {
        if (options[key] !== undefined && options[key] !== '') {
            const n = Number(options[key]);
            if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error(`Invalid ${key}`),{status:400});
            parts.push(`from_event_id ${op} ?`); args.push(n);
        }
    }
    return { sql: parts.length ? parts.join(' AND ') : '1=1', args };
}
function boundedLimit(limit = 200) {
    try { return Math.min(positive(limit, 200),10000); }
    catch (error) { error.status=400; throw error; }
}

export class GraphWriter {
    constructor(sessionId, { dataDir, shardEdgeLimit, batchSize } = {}) {
        this.sessionId = sessionId;
        this.shardEdgeLimit = positive(shardEdgeLimit, cfg('graph.shardEdgeLimit') ?? 100000);
        this.batchSize = Math.min(positive(batchSize, cfg('graph.batchSize') ?? 1000), this.shardEdgeLimit);
        const base = dataDir ?? resolve(dirname(db.raw().name), 'sessions', createHash('sha256').update(sessionId).digest('hex'));
        this.generation = randomUUID();
        this.path = resolve(base, 'dataflow', this.generation);
        mkdirSync(this.path, { recursive: true });
        this.catalog = new Database(resolve(this.path, 'catalog.sqlite'));
        configure(this.catalog, true);
        this.catalog.exec(`CREATE TABLE shards(id INTEGER PRIMARY KEY, edge_count INTEGER, first_id INTEGER, last_id INTEGER);
            CREATE TABLE locations(kind TEXT, node TEXT, direction TEXT, shard INTEGER,
                PRIMARY KEY(kind,node,direction,shard)) WITHOUT ROWID;
            CREATE TABLE variables(name TEXT PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE stats(edge_type TEXT PRIMARY KEY, cnt INTEGER NOT NULL) WITHOUT ROWID;
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;`);
        this.location = this.catalog.prepare('INSERT OR IGNORE INTO locations VALUES (?,?,?,?)');
        this.variable = this.catalog.prepare('INSERT OR IGNORE INTO variables VALUES (?)');
        this.stat = this.catalog.prepare('INSERT INTO stats VALUES (?,1) ON CONFLICT(edge_type) DO UPDATE SET cnt=cnt+1');
        this.count = 0; this.shardCount = 0; this.pending = [];
        this.published = false; this.finished = false;
        this.metrics = { maxBufferedEdges: 0, shardsWritten: 0 };
    }
    add(edge) {
        if (this.finished) throw new Error('Graph writer is closed');
        this.pending.push(edge);
        this.metrics.maxBufferedEdges = Math.max(this.metrics.maxBufferedEdges, this.pending.length);
        if (this.pending.length >= this.batchSize) this.flush();
    }
    startShard() {
        this.closeShard();
        this.shardCount++;
        this.shard = new Database(resolve(this.path, `edges-${this.shardCount}.sqlite`));
        configure(this.shard, true); this.shard.exec(EDGE_SCHEMA);
        this.insert = this.shard.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?)');
        this.shardRows = 0; this.firstId = this.count + 1;
    }
    closeShard() {
        if (!this.shard) return;
        this.shard.close(); this.shard = null;
        this.catalog.prepare('INSERT INTO shards VALUES (?,?,?,?)').run(this.shardCount, this.shardRows, this.firstId, this.count);
        this.metrics.shardsWritten++;
    }
    flush() {
        let position = 0;
        while (position < this.pending.length) {
            if (!this.shard || this.shardRows >= this.shardEdgeLimit) this.startShard();
            const end = Math.min(this.pending.length, position + this.shardEdgeLimit - this.shardRows);
            // Files remain unpublished until every shard and the catalog is closed.
            this.catalog.transaction(() => this.shard.transaction(() => {
                for (; position < end; position++) {
                    const e = this.pending[position];
                    const id = ++this.count;
                    this.insert.run(id,e.from_event_id ?? null,e.to_event_id ?? null,e.from_var ?? null,
                        e.to_var ?? null,e.edge_type,e.iid ?? null,e.line ?? null);
                    this.shardRows++;
                    for (const [direction, event, variable] of [
                        ['forward',e.from_event_id,e.from_var],['backward',e.to_event_id,e.to_var],
                    ]) {
                        if (event != null) this.location.run('event',String(event),direction,this.shardCount);
                        if (variable != null) {
                            this.location.run('var',variable,direction,this.shardCount);
                            this.variable.run(variable);
                        }
                    }
                    this.stat.run(e.edge_type);
                }
            })())();
        }
        this.pending = [];
    }
    publish() {
        this.flush(); this.closeShard();
        this.catalog.prepare('INSERT INTO metadata VALUES (?,?)').run('version',String(GRAPH_STORE_VERSION));
        this.catalog.prepare('INSERT INTO metadata VALUES (?,?)').run('edgeCount',String(this.count));
        this.catalog.close(); this.catalog = null; this.finished = true;
        // This row commits together with PluginEngine's checkpoint. The old
        // generation stays immutable and readable until readers release it.
        db.run(`INSERT INTO dataflow_graphs(session_id,generation,root_path,edge_count,shard_count,version,created_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
            generation=excluded.generation,root_path=excluded.root_path,edge_count=excluded.edge_count,
            shard_count=excluded.shard_count,version=excluded.version,created_at=excluded.created_at`,
        this.sessionId,this.generation,this.path,this.count,this.shardCount,GRAPH_STORE_VERSION,Date.now());
        this.published = true;
        return { edgeCount: this.count, shardCount: this.shardCount, storage: 'disk-sharded', ...this.metrics };
    }
    abort() {
        if (this.shard?.open) this.shard.close();
        if (this.catalog?.open) this.catalog.close();
        this.finished = true;
        rmSync(this.path, { recursive: true, force: true });
    }
}

export class GraphReader {
    constructor(sessionId, { maxOpenShards } = {}) {
        this.sessionId = sessionId;
        this.manifest = db.get('SELECT * FROM dataflow_graphs WHERE session_id=?',sessionId);
        this.handles = new Map();
        this.maxOpenShards = Math.min(positive(maxOpenShards, cfg('graph.maxOpenShards') ?? 4), 32);
        this.metrics = { shardsOpened: 0, maxOpenShards: 0, truncated: false };
        if (this.manifest) {
            if (this.manifest.version !== GRAPH_STORE_VERSION) throw new Error('Unsupported graph store version');
            this.catalog = new Database(resolve(this.manifest.root_path,'catalog.sqlite'), { readonly: true, fileMustExist: true });
            configure(this.catalog);
        }
    }
    shard(id) {
        if (this.handles.has(id)) {
            const connection = this.handles.get(id); this.handles.delete(id); this.handles.set(id,connection); return connection;
        }
        if (this.handles.size >= this.maxOpenShards) {
            const first = this.handles.keys().next().value; this.handles.get(first).close(); this.handles.delete(first);
        }
        const connection = new Database(resolve(this.manifest.root_path,`edges-${id}.sqlite`), { readonly: true, fileMustExist: true });
        configure(connection); this.handles.set(id,connection);
        this.metrics.shardsOpened++; this.metrics.maxOpenShards = Math.max(this.metrics.maxOpenShards,this.handles.size);
        return connection;
    }
    stats() {
        return this.catalog ? this.catalog.prepare('SELECT edge_type,cnt FROM stats ORDER BY cnt DESC,edge_type').all()
            : db.all('SELECT edge_type,COUNT(*) cnt FROM dataflow_edges WHERE session_id=? GROUP BY edge_type ORDER BY cnt DESC,edge_type',this.sessionId);
    }
    list(options = {}) {
        const limit = boundedLimit(options.limit);
        const offset = Number(options.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Invalid offset'),{status:400});
        const f = filters(options);
        if (!this.catalog) return {
            edges: db.all(`SELECT ${COLUMNS} FROM dataflow_edges WHERE session_id=? AND ${f.sql} ORDER BY id LIMIT ? OFFSET ?`,this.sessionId,...f.args,limit,offset),
            total: db.get(`SELECT COUNT(*) n FROM dataflow_edges WHERE session_id=? AND ${f.sql}`,this.sessionId,...f.args).n,
            stats: this.stats(), offset,
        };
        const edges = []; let total = 0;
        const candidates = options.varExact
            ? this.catalog.prepare(`SELECT s.id,s.edge_count FROM shards s JOIN
                (SELECT DISTINCT shard FROM locations WHERE kind='var' AND node=?) l ON s.id=l.shard ORDER BY s.id`).iterate(options.varExact)
            : this.catalog.prepare('SELECT id,edge_count FROM shards ORDER BY id').iterate();
        for (const item of candidates) {
            const count = f.sql === '1=1' ? item.edge_count
                : this.shard(item.id).prepare(`SELECT COUNT(*) n FROM edges WHERE ${f.sql}`).get(...f.args).n;
            if (edges.length < limit && total + count > offset) {
                edges.push(...this.shard(item.id).prepare(`SELECT ${COLUMNS} FROM edges WHERE ${f.sql} ORDER BY id LIMIT ? OFFSET ?`)
                    .all(...f.args,limit-edges.length,Math.max(0,offset-total)));
            }
            total += count;
        }
        return { edges,total,stats:this.stats(),offset };
    }
    variables(prefix = '', limit = 100) {
        limit = boundedLimit(limit);
        if (this.catalog) return this.catalog.prepare("SELECT name FROM variables WHERE name NOT LIKE '#%' AND name LIKE ? ORDER BY name LIMIT ?")
            .all(`${prefix}%`,limit).map(r=>r.name);
        return db.all(`SELECT var FROM (SELECT from_var var FROM dataflow_edges WHERE session_id=?
            UNION SELECT to_var var FROM dataflow_edges WHERE session_id=?)
            WHERE var NOT LIKE '#%' AND var LIKE ? ORDER BY var LIMIT ?`,this.sessionId,this.sessionId,`${prefix}%`,limit).map(r=>r.var);
    }
    neighbors(kind, key, direction = 'both', limit = 100) {
        if (!['event','var'].includes(kind) || !['forward','backward','both'].includes(direction)) throw Object.assign(new Error('Invalid graph traversal'),{status:400});
        limit = boundedLimit(limit);
        const from = kind === 'event' ? 'from_event_id' : 'from_var';
        const to = kind === 'event' ? 'to_event_id' : 'to_var';
        const where = direction === 'both' ? `(${from}=? OR ${to}=?)` : `${direction === 'forward' ? from : to}=?`;
        const params = direction === 'both' ? [key,key] : [key];
        if (!this.catalog) {
            const rows = db.all(`SELECT ${COLUMNS} FROM dataflow_edges WHERE session_id=? AND ${where} ORDER BY id LIMIT ?`,this.sessionId,...params,limit+1);
            if (rows.length>limit) this.metrics.truncated = true;
            return rows.slice(0,limit);
        }
        const shards = direction === 'both'
            ? this.catalog.prepare('SELECT DISTINCT shard FROM locations WHERE kind=? AND node=? ORDER BY shard').iterate(kind,String(key))
            : this.catalog.prepare('SELECT shard FROM locations WHERE kind=? AND node=? AND direction=? ORDER BY shard').iterate(kind,String(key),direction);
        const rows = [];
        for (const item of shards) {
            rows.push(...this.shard(item.shard).prepare(`SELECT ${COLUMNS} FROM edges WHERE ${where} ORDER BY id LIMIT ?`).all(...params,limit+1-rows.length));
            if (rows.length > limit) { this.metrics.truncated = true; break; }
        }
        return rows.slice(0,limit);
    }
    close() {
        for (const connection of this.handles.values()) connection.close();
        this.handles.clear(); this.catalog?.close(); this.catalog = null;
    }
}

export function withGraph(sessionId, callback) {
    const graph = new GraphReader(sessionId);
    try { return callback(graph); } finally { graph.close(); }
}
