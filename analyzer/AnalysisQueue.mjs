import { createLogger } from './logger.mjs';
import { randomUUID } from 'crypto';
import { executionBudget } from './ExecutionBudget.mjs';
import { collectGraphGenerations } from './GraphStore.mjs';
import { Worker } from 'worker_threads';
import * as db from './db/Database.mjs';
import { cfg } from './Config.mjs';

const log = createLogger('AnalysisQueue');
const pending = new Map();
let tail = Promise.resolve();

// A single writer avoids SQLite lock contention; CPU work lives outside the API thread.
export function enqueueAnalysis(mode, sessionId, options = {}) {
    if (pending.has(sessionId)) return Promise.reject(new Error(`Session ${sessionId} already has an analysis job`));
    if (pending.size >= (cfg('analysis.maxQueue') ?? 32)) return Promise.reject(new Error('Analysis queue is full'));
    const { onProgress, signal, worker, ...serializable } = options;
    const graphOwner = randomUUID();
    const job = tail.catch(() => {}).then(() => executionBudget.run(() => new Promise((resolve, reject) => {
        if (signal?.aborted) { db.run("UPDATE sessions SET status='failed' WHERE id=?",sessionId); reject(new Error('Analysis cancelled')); return; }
        const instance = new Worker(new URL('./analysis.worker.mjs', import.meta.url), {
            workerData: { mode, sessionId, options: { ...serializable, settleSession: false }, graphOwner, dbPath: db.raw().name },
            resourceLimits: { maxOldGenerationSizeMb: cfg('analysis.maxHeapMb') ?? 512 },
        });
        let settled = false;
        let reported = null;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            try { collectGraphGenerations(sessionId, { dataDir: options.dataDir, finishedOwner: graphOwner }); }
            catch (error) { log.warn({ err: error, sessionId }, 'Graph cleanup deferred'); }
            if (error) reject(error);
            else {
                db.run("UPDATE sessions SET status='ready' WHERE id=?", sessionId);
                resolve(result);
            }
        };
        const abort = () => { reported = { type: 'error' }; instance.terminate().then(() => finish(new Error('Analysis cancelled'))); };
        const timer = setTimeout(() => { reported = { type: 'error' }; instance.terminate().then(() => finish(new Error('Analysis timed out'))); }, cfg('analysis.timeoutMs') ?? 600000);
        signal?.addEventListener('abort', abort, { once: true });
        instance.on('message', message => {
            if (message.type === 'progress') { try { onProgress?.(message.event); } catch { /* subscriber cannot fail the job */ } return; }
            if (message.type === 'done' || message.type === 'error') {
                reported = message;
                instance.terminate().then(() => finish(message.type === 'error' ? new Error(message.error) : null, message.result));
            }
        });
        instance.on('error', error => { reported = { type: 'error' }; instance.terminate().then(() => finish(error)); });
        instance.on('exit', code => { if (!settled && !reported) finish(new Error(`Analysis worker exited (${code})`)); });
    }), { signal })).catch(error => {
        db.run("UPDATE sessions SET status='failed' WHERE id=?", sessionId);
        throw error;
    }).finally(() => pending.delete(sessionId));
    pending.set(sessionId, job);
    tail = job;
    return job;
}

// Used before closing the database, including graceful shutdown and test teardown.
export async function drainAnalysis() {
    while (true) { const current = tail; await current.catch(() => {}); if (current === tail) return; }
}
