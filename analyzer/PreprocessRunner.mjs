import { Worker } from 'worker_threads';
import { cfg } from './Config.mjs';
import { executionBudget } from './ExecutionBudget.mjs';
export function preprocessCode(code, options) {
    return executionBudget.run(async () => {
        return await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./preprocess.worker.mjs', import.meta.url), {
                workerData: { code, options }, resourceLimits: { maxOldGenerationSizeMb: cfg('analysis.maxHeapMb') ?? 512 },
            });
            let settled = false;
            let reported = false;
            const finish = (error, result) => {
                if (settled) return; settled = true; clearTimeout(timer);
                error ? reject(error) : resolve(result);
            };
            const timer = setTimeout(() => { reported = true; worker.terminate().then(() => finish(new Error('Preprocess timed out'))); }, cfg('runner.timeoutMs'));
            worker.on('message', data => { reported = true; worker.terminate().then(() => finish(data.error ? new Error(data.error) : null, data.result)); });
            worker.on('error', error => { reported = true; worker.terminate().then(() => finish(error)); });
            worker.on('exit', code => { if (!settled && !reported) finish(new Error(`Preprocess worker exited (${code})`)); });
        });
    });
}
