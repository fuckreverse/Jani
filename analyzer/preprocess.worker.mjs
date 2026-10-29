import { parentPort, workerData } from 'worker_threads';
import { preprocessCode } from '../src/preprocess/index.js';
try {
    const result = await preprocessCode(workerData.code, workerData.options);
    parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: error.message }); }
