import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRE_QR_EGRESS_HINT,
  computeReconnectDelayMs,
  createPreQrCloseHint,
  createReconnectScheduler,
  readReconnectTiming,
  redactWhatsAppId,
  resolveListenHost,
} from '../bridge_helpers.js';

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
    async fireOne() {
      const item = items.shift();
      if (!item) return;
      await item.fn();
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

test('pre-QR close hint latches until QR or open and stays quiet for a paired session', () => {
  assert.equal(
    PRE_QR_EGRESS_HINT,
    '⚠️  Pairing may be stuck — WhatsApp WSS likely failing before QR (check container egress).',
  );

  const hint = createPreQrCloseHint();
  hint.noteSocketAttempt({ registered: false });
  assert.equal(hint.consume(408), true);
  assert.equal(hint.consume(408), false);
  hint.noteSocketAttempt({ registered: false });
  assert.equal(hint.consume(428), false);

  hint.noteQr();
  assert.equal(hint.consume(408), false);
  hint.noteSocketAttempt({ registered: false });
  assert.equal(hint.consume(408), true);

  hint.noteOpen();
  hint.noteSocketAttempt({ registered: false });
  assert.equal(hint.consume(408), false);
  assert.equal(hint.consume(428), false);

  hint.resetAfterLogout();
  hint.noteSocketAttempt({ registered: true, me: { id: '15550001111:1@s.whatsapp.net' } });
  assert.equal(hint.consume(408), false);
  hint.noteSocketAttempt({ me: { id: '15550001111:1@s.whatsapp.net' } });
  assert.equal(hint.consume(408), false);

  hint.noteSocketAttempt({ registered: false });
  assert.equal(hint.consume(401), false);
  assert.equal(hint.consume(515), false);
  assert.equal(hint.consume(500), false);
  assert.equal(hint.consume(408), true);

  const other = createPreQrCloseHint();
  other.noteSocketAttempt({ registered: false });
  assert.equal(other.consume(408), true);
});

test('reconnect delay doubles from 3s to a 60s cap, with jitter around the center', () => {
  assert.equal(computeReconnectDelayMs(0, { random: () => 0.5 }), 3000);
  assert.equal(computeReconnectDelayMs(1, { random: () => 0.5 }), 6000);
  assert.equal(computeReconnectDelayMs(2, { random: () => 0.5 }), 12000);
  assert.equal(computeReconnectDelayMs(4, { random: () => 0.5 }), 48000);
  assert.equal(computeReconnectDelayMs(5, { random: () => 0.5 }), 60000);
  assert.equal(computeReconnectDelayMs(8, { random: () => 0.5 }), 60000);
  assert.equal(computeReconnectDelayMs(0, { random: () => 0 }), 2400);
  assert.equal(computeReconnectDelayMs(0, { random: () => 1 }), 3600);
  assert.equal(computeReconnectDelayMs(5, { random: () => 1 }), 60000);
  assert.equal(computeReconnectDelayMs(0, { baseMs: 3000, capMs: 1000, random: () => 0.5 }), 1000);
});

test('listen host stays on loopback unless the container wildcard is set', () => {
  assert.equal(resolveListenHost({}), '127.0.0.1');
  assert.equal(resolveListenHost({ WHATSAPP_BIND_HOST: '' }), '127.0.0.1');
  assert.equal(resolveListenHost({ WHATSAPP_BIND_HOST: '  0.0.0.0  ' }), '0.0.0.0');
  assert.equal(resolveListenHost({ WHATSAPP_BIND_HOST: '::1' }), '::1');
  assert.throws(
    () => resolveListenHost({ WHATSAPP_BIND_HOST: '192.168.1.9' }),
    /WHATSAPP_BIND_HOST/,
  );
  assert.throws(
    () => resolveListenHost({ WHATSAPP_BIND_HOST: 'localhost' }),
    /WHATSAPP_BIND_HOST/,
  );
});

test('reconnect timing env knobs fall back to 3s and 60s', () => {
  assert.deepEqual(readReconnectTiming({}), { baseMs: 3000, capMs: 60000 });
  assert.deepEqual(readReconnectTiming({
    WHATSAPP_RECONNECT_BASE_MS: '',
    WHATSAPP_RECONNECT_CAP_MS: 'nope',
  }), { baseMs: 3000, capMs: 60000 });
  assert.deepEqual(readReconnectTiming({
    WHATSAPP_RECONNECT_BASE_MS: '4000',
    WHATSAPP_RECONNECT_CAP_MS: '15000',
  }), { baseMs: 4000, capMs: 15000 });
});

test('close backoff grows per scheduler, 515 stays at 1s, and open resets', async () => {
  const clock = createClock();
  const delays = [];
  let failStarts = 0;
  const schedule = createReconnectScheduler(
    () => {
      failStarts += 1;
      throw new Error('socket down');
    },
    {
      random: () => 0.5,
      log: () => {},
      setTimeoutFn: (fn, ms) => {
        delays.push(ms);
        return clock.setTimeout(fn, ms);
      },
      clearTimeoutFn: clock.clearTimeout,
    },
  );

  assert.equal(schedule.afterClose(), 3000);
  assert.equal(schedule.afterClose(), 6000);
  assert.equal(schedule.afterClose({ restartRequested: true }), 1000);
  assert.equal(schedule.attempt(), 2);

  const otherClock = createClock();
  const other = createReconnectScheduler(() => {}, {
    random: () => 0.5,
    log: () => {},
    setTimeoutFn: otherClock.setTimeout,
    clearTimeoutFn: otherClock.clearTimeout,
  });
  assert.equal(other.afterClose(), 3000);
  assert.equal(other.attempt(), 1);

  schedule.noteOpen();
  assert.equal(schedule.attempt(), 0);
  assert.equal(schedule.afterClose(), 3000);

  await clock.fireOne();
  assert.equal(failStarts, 1);
  assert.equal(delays.at(-1), 6000);
  schedule.cancel();
  await clock.fireOne();
  assert.equal(failStarts, 1);
});
