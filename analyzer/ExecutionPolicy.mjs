import { basename } from 'path';

export function validateFilename(filename) {
    if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' ||
        basename(filename) !== filename || /[\\/\x00-\x1f]/.test(filename)) {
        const error = new Error('filename must be a plain file name, without path components');
        error.status = 400;
        throw error;
    }
    return filename;
}

export function executionEnv() {
    const env = { NODE_ENV: 'production' };
    for (const key of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return env;
}

export function allowedOrigin(origin, port, extra = '') {
    if (!origin) return true; // CLI clients do not send Origin.
    const allowed = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`,
        'http://localhost:5173', 'http://127.0.0.1:5173', ...extra.split(',').map(s => s.trim()).filter(Boolean)]);
    return allowed.has(origin);
}

export function killProcessTree(child) {
    try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
    } catch { /* already exited */ }
}
