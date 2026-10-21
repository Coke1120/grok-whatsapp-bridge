import assert from 'node:assert/strict';
import test from 'node:test';
import { createReconnectScheduler, redactWhatsAppId } from '../bridge_helpers.js';

function createClock() {
  let seq = 1;
  const items = [];
  return {
    setTimeout(fn, ms) {
      const handle = seq++;
      items.push({ handle, fn, ms });
      return handle;
    },
    clearTimeout(handle) {
      const index = items.findIndex((item) => item.handle === handle);
      if (index >= 0) items.splice(index, 1);
    },
    get pending() {
      return items.length;
    },
    async flush() {
      for (let i = 0; i < 10 && items.length; i += 1) {
        const batch = items.splice(0, items.length);
        for (const item of batch) item.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('redactWhatsAppId keeps the last four digits and the domain', () => {
  assert.equal(redactWhatsAppId('15550001111:1@s.whatsapp.net'), '…1111@s.whatsapp.net');
  assert.equal(redactWhatsAppId(''), '');
});

test('cancel drops a scheduled reconnect and ignores an in-flight failure', async () => {
  const clock = createClock();
  let rejectStart = null;
  const schedule = createReconnectScheduler(
    () => new Promise((_, reject) => {
      rejectStart = reject;
    }),
    {
      retryDelayMs: 5000,
      log: () => {},
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    },
  );

  schedule(0);
  await clock.flush();
  assert.equal(typeof rejectStart, 'function');
  schedule.cancel();
  rejectStart(new Error('boom'));
  await clock.flush();
  assert.equal(clock.pending, 0);

  schedule.enable();
  let starts = 0;
  const resumed = createReconnectScheduler(
    () => {
      starts += 1;
    },
    {
      log: () => {},
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    },
  );
  resumed(0);
  resumed.cancel();
  resumed.enable();
  resumed(0);
  await clock.flush();
  assert.equal(starts, 1);
});
