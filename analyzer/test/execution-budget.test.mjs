import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBudget, executionBudget } from '../ExecutionBudget.mjs';
import { runProcess } from '../ProcessRunner.mjs';
import { preprocessCode } from '../PreprocessRunner.mjs';
import { startRun } from '../InstrumentRunner.mjs';
import { reload } from '../Config.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('the shared budget bounds mixed real preprocessing and process work, then drains FIFO', async () => {
    process.env.JTA_RUNNER_MAXCONCURRENCY = '1';
    process.env.JTA_RUNNER_MAXQUEUE = '1'; reload();
    const hold = executionBudget.reserve();
    try {
        const processJob = runProcess('node', ['-e', 'process.stdout.write("instrumented")']);
        await assert.rejects(preprocessCode('var x=1;', {}), error => error.status === 429);
        assert.throws(() => startRun({ code:'var x=1;' }), error => error.status === 429);
        assert.equal(executionBudget.active, 1); assert.equal(executionBudget.waiting.length, 1);
        hold.release();
        const result = await processJob; assert.equal(result.stdout, 'instrumented');
        const output = await preprocessCode('var x=1;', {}); assert.equal(typeof output.code, 'string');
        assert.equal(executionBudget.active, 0); assert.equal(executionBudget.waiting.length, 0);
    } finally {
        hold.release(); delete process.env.JTA_RUNNER_MAXCONCURRENCY; delete process.env.JTA_RUNNER_MAXQUEUE; reload();
    }
});

test('failed work and cancelled queued work release reservations without exceeding capacity', async () => {
    const budget = new ExecutionBudget({ concurrency: () => 1, maxQueue: () => 2 });
    const hold = budget.reserve(), controller = new AbortController();
    const cancelled = budget.run(() => assert.fail('cancelled callback ran'), { signal: controller.signal });
    controller.abort(); await assert.rejects(cancelled, /cancelled/);
    let finish; const order = [];
    const first = budget.run(() => new Promise(resolve => { order.push(1); finish = resolve; }));
    const second = budget.run(() => { order.push(2); throw new Error('failed work'); });
    const rejected = assert.rejects(second, /failed work/);
    assert.throws(() => budget.reserve(), error => error.status === 429);
    hold.release(); await tick(); assert.deepEqual(order, [1]); assert.equal(budget.active, 1);
    finish(); await first; await rejected;
    assert.deepEqual(order, [1, 2]); assert.equal(budget.active, 0);
    await budget.run(() => {}); assert.equal(budget.active, 0);
});
