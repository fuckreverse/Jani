import { spawn } from 'child_process';
import { cfg } from './Config.mjs';
import { executionEnv, killProcessTree } from './ExecutionPolicy.mjs';

import { executionBudget } from './ExecutionBudget.mjs';

export function runProcess(cmd, args, opts = {}) {
    return executionBudget.run(() => runProcessImpl(cmd, args, opts));
}
function runProcessImpl(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = spawn(process.execPath, args, {
            ...opts,
            env: executionEnv(),
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, cfg('runner.timeoutMs'));
        child.stdout.on('data', d => { stdout = (stdout + d.toString()).slice(0, cfg('runner.maxOutputBytes')); });
        child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(0, cfg('runner.maxOutputBytes')); });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ exitCode: timedOut ? 1 : (code ?? 1), stdout, stderr: timedOut ? 'Instrumentation timed out' : stderr });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ exitCode: 1, stdout, stderr: err.message });
        });
    });
}
