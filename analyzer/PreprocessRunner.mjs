import { Worker } from 'worker_threads';
import { cfg } from './Config.mjs';
let active = 0;
const waiting = [];
export async function preprocessCode(code, options) {
    if (waiting.length >= (cfg('runner.maxQueue') ?? 32)) throw new Error('Preprocess queue is full');
    if (active >= cfg('runner.maxConcurrency')) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try {
        return await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./preprocess.worker.mjs', import.meta.url), {
                workerData: { code, options }, resourceLimits: { maxOldGenerationSizeMb: cfg('analysis.maxHeapMb') ?? 512 },
            });
            let settled = false;
            const finish = (error, result) => {
                if (settled) return; settled = true; clearTimeout(timer);
                error ? reject(error) : resolve(result);
            };
            const timer = setTimeout(() => worker.terminate().then(() => finish(new Error('Preprocess timed out'))), cfg('runner.timeoutMs'));
            worker.on('message', data => finish(data.error ? new Error(data.error) : null, data.result));
            worker.on('error', finish);
            worker.on('exit', code => { if (!settled) finish(new Error(`Preprocess worker exited (${code})`)); });
        });
    } finally {
        if (waiting.length) waiting.shift()(); else active--;
    }
}
