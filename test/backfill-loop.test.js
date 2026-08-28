// Regression tests for the resident backfill loop.
// Run: node --test test/
//
// The bug these guard (defect 2, 2026-08-28): the backlog drain ran exactly once,
// at boot. A provider that wasn't ready at that instant left memories pending for
// the whole session, and reconnecting the server — the obvious remedy — was just
// another boot into the same window, so it looked like the drain was broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBackfillLoop } from '../server/backlog.js';

// Drives the loop without real timers. The injected sleep must yield through the
// MACROtask queue (setImmediate), not just resolve: an await-only loop starves
// the timer phase, so anything waiting on setTimeout — including the test runner
// — never runs again.
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

function runLoop({ pending, attempts, ticks = attempts.length + 2 }) {
  const log = [];
  let drains = 0, sleeps = 0, stop;
  const done = new Promise(resolve => {
    stop = startBackfillLoop({}, m => log.push(m), {
      count: () => pending,
      drain: async () => {
        const step = attempts[Math.min(drains, attempts.length - 1)];
        drains++;
        if (step instanceof Error) throw step;
        return step;
      },
      // Bound the run so a regression fails the test instead of hanging it.
      sleep: async () => {
        await yieldToEventLoop();
        if (++sleeps >= ticks) { stop(); resolve(); }
      },
    });
  });
  return done.then(() => ({ log, drains: () => drains }));
}

test('retries after a failed attempt instead of giving up at boot', async () => {
  const { log } = await runLoop({
    pending: 3,
    attempts: [
      { drained: 0, remaining: 3, reason: 'provider_down', message: 'ECONNREFUSED' },
      { drained: 3, remaining: 0 },
    ],
  });
  assert.ok(log.some(l => /still pending — provider_down/.test(l)), 'first failure reported');
  assert.ok(log.some(l => /backfilled 3/.test(l)), 'the retry is what fixes it');
});

test('an empty backlog never touches the provider', async () => {
  const { log, drains } = await runLoop({ pending: 0, attempts: [{ drained: 0, remaining: 0 }] });
  assert.equal(drains(), 0, 'drain must not be called when nothing is pending');
  assert.deepEqual(log, []);
});

test('a thrown error is reported, not swallowed', async () => {
  // The old call site was `.catch(() => {})`, which made a real exception here
  // indistinguishable from a quiet success.
  const { log } = await runLoop({
    pending: 1,
    attempts: [new Error('database is locked'), { drained: 1, remaining: 0 }],
  });
  assert.ok(log.some(l => /backfill attempt failed/.test(l) && /database is locked/.test(l)));
});

test('a persistently down provider is reported once, not every interval', async () => {
  const fail = { drained: 0, remaining: 2, reason: 'provider_down', message: 'ECONNREFUSED' };
  const { log } = await runLoop({ pending: 2, attempts: [fail, fail, fail, fail] });
  assert.equal(log.filter(l => /still pending/.test(l)).length, 1, 'no per-interval spam');
});

test('a changed failure reason is reported again', async () => {
  const { log } = await runLoop({
    pending: 2,
    attempts: [
      { drained: 0, remaining: 2, reason: 'provider_down', message: 'ECONNREFUSED' },
      { drained: 0, remaining: 2, reason: 'model_missing', message: 'not installed' },
      { drained: 2, remaining: 0 },
    ],
  });
  assert.ok(log.some(l => /provider_down/.test(l)));
  assert.ok(log.some(l => /model_missing/.test(l)), 'a new cause must not be hidden by the last one');
});

test('stop() ends the loop', async () => {
  let calls = 0;
  const stop = startBackfillLoop({}, () => {}, {
    count: () => 1,
    drain: async () => { calls++; return { drained: 1, remaining: 0 }; },
    sleep: yieldToEventLoop,
  });
  await yieldToEventLoop();
  stop();
  const seen = calls;
  for (let i = 0; i < 5; i++) await yieldToEventLoop();
  assert.equal(calls, seen, 'no further attempts after stop()');
});
