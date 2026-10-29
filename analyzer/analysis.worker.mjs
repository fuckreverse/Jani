import { analyzeSession } from './SessionAnalysis.mjs';
import { parentPort, workerData } from 'worker_threads';
import * as db from './db/Database.mjs';
import { autoDiscover, schedule, runSinglePlugin } from './PluginEngine.mjs';
const started = performance.now();
let message;
try {
    await db.init(workerData.dbPath);
    await autoDiscover();
    const options = { ...workerData.options, onProgress: event => parentPort.postMessage({ type: 'progress', event }) };
    const result = workerData.mode === 'workflow'
        ? await analyzeSession(workerData.sessionId, { ...options, worker: false })
        : workerData.mode === 'single'
        ? await runSinglePlugin(workerData.sessionId, options.pluginId, options)
        : await schedule(workerData.sessionId, options);
    parentPort.postMessage({ type: 'progress', event: { type: 'analysis_metrics', sessionId: workerData.sessionId,
        durationMs: performance.now()-started, heapUsedBytes: process.memoryUsage().heapUsed } });
    message = { type: 'done', result };
} catch (error) {
    message = { type: 'error', error: error.message };
} finally { db.close(); }
parentPort.postMessage(message);
parentPort.close();
