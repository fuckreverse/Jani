import { cfg } from './Config.mjs';

// One admission budget for preprocessing, instrumentation, execution and analysis.
// Reservations are synchronous so HTTP callers can reject overload before creating work.
export class ExecutionBudget {
    constructor({ concurrency = () => cfg('runner.maxConcurrency'), maxQueue = () => cfg('runner.maxQueue') ?? 32 } = {}) {
        this.concurrency = concurrency;
        this.maxQueue = maxQueue;
        this.active = 0;
        this.waiting = [];
    }
    reserve({ signal } = {}) {
        if (signal?.aborted) throw new Error('Execution cancelled');
        const limit = Number(this.concurrency());
        const queueLimit = Number(this.maxQueue());
        if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 0) {
            throw new Error('Execution limits must be valid integers');
        }
        if (this.active >= limit && this.waiting.length >= queueLimit) {
            throw Object.assign(new Error('Execution queue is full'), { status: 429 });
        }
        let admit, reject;
        const ready = new Promise((resolve, fail) => { admit = resolve; reject = fail; });
        const abort = () => {
            if (ticket.running || ticket.released) return;
            reject(new Error('Execution cancelled')); ticket.release();
        };
        const ticket = { ready, running: false, released: false, admit, signal, abort };
        ticket.release = () => {
            if (ticket.released) return;
            ticket.released = true;
            signal?.removeEventListener('abort', abort);
            if (ticket.running) this.active--;
            else { const index = this.waiting.indexOf(ticket); if (index >= 0) this.waiting.splice(index, 1); admit(); }
            while (this.waiting.length && this.active < Number(this.concurrency())) {
                const next = this.waiting.shift(); next.running = true; this.active++; next.signal?.removeEventListener('abort', next.abort); next.admit();
            }
        };
        if (this.active < limit) { ticket.running = true; this.active++; admit(); }
        else { this.waiting.push(ticket); signal?.addEventListener('abort', abort, { once: true }); }
        return ticket;
    }
    async run(callback, options) {
        const ticket = this.reserve(options);
        try { await ticket.ready; return await callback(); }
        finally { ticket.release(); }
    }
}
export const executionBudget = new ExecutionBudget();
