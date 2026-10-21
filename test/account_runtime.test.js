import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { DEFAULT_REPLY_PREFIX } from '../accounts_config.js';
import { createAccountRuntime } from '../account_runtime.js';

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
        for (const item of batch) await item.fn();
      }
    },
  };
}

function createFakeSocket() {
  const handlers = new Map();
  const sent = [];
  const readKeys = [];
  const sock = {
    user: { id: '15550001111:1@s.whatsapp.net', name: 'Test' },
    ev: {
      on(event, fn) {
        const list = handlers.get(event) || [];
        list.push(fn);
        handlers.set(event, list);
      },
      removeAllListeners(event) {
        if (event) handlers.delete(event);
        else handlers.clear();
      },
    },
    async sendMessage(jid, payload, options) {
      sent.push({ jid, payload, options });
      return { key: { id: `id-${sent.length}` }, message: payload };
    },
    async sendPresenceUpdate() {},
    async readMessages(keys) {
      readKeys.push(keys);
    },
    async groupMetadata() {
      return { subject: 'Group', participants: [{ id: '1@s.whatsapp.net' }] };
    },
    async updateMediaMessage() {},
    async logout() {},
    end() {},
  };
  return {
    sock,
    sent,
    readKeys,
    async emit(event, payload) {
      for (const fn of handlers.get(event) || []) await fn(payload);
    },
  };
}

function closeUpdate(statusCode) {
  return {
    connection: 'close',
    lastDisconnect: { error: new Boom('closed', { statusCode }) },
  };
}

function harness(dir, overrides = {}) {
  const clock = createClock();
  const sockets = [];
  const exits = [];
  const authDirs = [];
  const { deps: overrideDeps = {}, ...rest } = overrides;
  const runtime = createAccountRuntime({
    name: 'default',
    sessionDir: dir,
    mode: 'bot',
    multi: false,
    replyPrefix: '',
    allowedUsers: '111',
    groupAllowedUsers: '',
    dmPolicy: 'open',
    groupPolicy: 'pairing',
    forwardOwnerMessages: false,
    sendReadReceipts: false,
    maxMessageLength: 4096,
    chunkDelayMs: 0,
    sendTimeoutMs: 1000,
    cacheDirs: { image: dir, document: dir, audio: dir },
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    reconnectRetryMs: 5000,
    log() {},
    deps: {
      exitProcess(code) { exits.push(code); },
      async useMultiFileAuthState(sessionDir) {
        authDirs.push(sessionDir);
        return { state: { creds: {} }, saveCreds() {} };
      },
      makeWASocket() {
        const fake = createFakeSocket();
        sockets.push(fake);
        return fake.sock;
      },
      async getWAVersion() { return [2, 3000, 1]; },
      ...overrideDeps,
    },
    ...rest,
  });
  return { runtime, clock, sockets, exits, authDirs };
}

async function connect(handle) {
  await handle.runtime.start();
  await handle.clock.flush();
  await handle.sockets.at(-1).emit('connection.update', { connection: 'open' });
}

test('a disconnected account does not send', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const handle = harness(dir);
    const result = await handle.runtime.send({ chatId: '111@s.whatsapp.net', message: 'hi' });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'Not connected to WhatsApp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('single-account remote logout exits and does not reconnect', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const handle = harness(dir);
    await connect(handle);
    await handle.sockets[0].emit('connection.update', closeUpdate(DisconnectReason.loggedOut));
    assert.deepEqual(handle.exits, [1]);
    assert.equal(handle.runtime.getStatus(), 'logged_out');
    await handle.clock.flush();
    assert.equal(handle.sockets.length, 1);
    assert.equal(handle.authDirs[0], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-account remote logout stays in-process and does not reconnect', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const handle = harness(dir, { name: 'sales', multi: true });
    await connect(handle);
    await handle.sockets[0].emit('connection.update', closeUpdate(DisconnectReason.loggedOut));
    assert.deepEqual(handle.exits, []);
    assert.equal(handle.runtime.getStatus(), 'logged_out');
    await handle.clock.flush();
    assert.equal(handle.sockets.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal disconnect reconnects only that account', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const handle = harness(dir, { multi: true, name: 'ops' });
    await connect(handle);
    await handle.sockets[0].emit('connection.update', closeUpdate(408));
    assert.equal(handle.runtime.getStatus(), 'disconnected');
    assert.equal(handle.clock.pending, 1);
    await handle.clock.flush();
    assert.equal(handle.sockets.length, 2);
    await handle.sockets[1].emit('connection.update', { connection: 'open' });
    await handle.sockets[0].emit('connection.update', closeUpdate(DisconnectReason.loggedOut));
    assert.equal(handle.runtime.getStatus(), 'connected');
    assert.deepEqual(handle.exits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pause releases the socket and resume starts a new one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const handle = harness(dir, { multi: true, name: 'sales' });
    await connect(handle);
    const paused = await handle.runtime.pause();
    assert.equal(paused.body.status, 'paused');
    assert.equal(handle.runtime.getStatus(), 'paused');
    await handle.clock.flush();
    assert.equal(handle.sockets.length, 1);
    await handle.runtime.resume();
    await handle.clock.flush();
    assert.equal(handle.sockets.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit logout defers process exit only for the single-account bridge', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const single = harness(dir);
    await connect(single);
    await single.runtime.logout();
    assert.equal(single.runtime.getStatus(), 'logged_out');
    assert.deepEqual(single.exits, []);
    await single.clock.flush();
    assert.deepEqual(single.exits, [1]);

    const multiDir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
    const multi = harness(multiDir, { multi: true, name: 'ops' });
    await connect(multi);
    await multi.runtime.logout();
    await multi.clock.flush();
    assert.deepEqual(multi.exits, []);
    rmSync(multiDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('send queues are per account and self-chat still prefixes', async () => {
  const dirA = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const a = harness(dirA, { name: 'ops', multi: true });
    const b = harness(dirB, {
      name: 'sales',
      multi: true,
      mode: 'self-chat',
      replyPrefix: DEFAULT_REPLY_PREFIX,
    });
    await connect(a);
    await connect(b);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    a.sockets[0].sock.sendMessage = async (jid, payload) => {
      await gate;
      return { key: { id: 'slow' }, message: payload, jid };
    };
    const pending = a.runtime.send({ chatId: '111@s.whatsapp.net', message: 'slow' });
    const fast = await b.runtime.send({ chatId: '111@s.whatsapp.net', message: 'hello' });
    assert.equal(fast.status, 200);
    assert.equal(fast.body.messageId, 'id-1');
    assert.equal(b.sockets[0].sent[0].payload.text, `${DEFAULT_REPLY_PREFIX}hello`);
    release();
    const slow = await pending;
    assert.equal(slow.body.messageId, 'slow');
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('long text is split and read receipts follow the account flag', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const handle = harness(dir, { maxMessageLength: 4, sendReadReceipts: true });
    await connect(handle);
    const sent = await handle.runtime.send({ chatId: '111@s.whatsapp.net', message: 'abcd efgh' });
    assert.equal(sent.status, 200);
    assert.equal(handle.sockets[0].sent.length, 2);
    assert.deepEqual(sent.body.messageIds, ['id-1', 'id-2']);

    const marked = await handle.runtime.markRead({
      key: { remoteJid: '111@s.whatsapp.net', id: 'abc', fromMe: false },
    });
    assert.equal(marked.body.marked, true);
    assert.equal(handle.sockets[0].readKeys.length, 1);

    const quiet = harness(dir, { name: 'quiet', sendReadReceipts: false });
    await connect(quiet);
    const skipped = await quiet.runtime.markRead({
      key: { remoteJid: '111@s.whatsapp.net', id: 'abc', fromMe: false },
    });
    assert.equal(skipped.body.marked, false);
    assert.equal(quiet.sockets[0].readKeys.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbound messages are allowlisted per account and tagged only in multi mode', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const single = harness(dir, { allowedUsers: '111' });
    await connect(single);
    await single.sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: '111@s.whatsapp.net', fromMe: false, id: 'm1' },
        message: { conversation: 'hello' },
        pushName: 'Ada',
        messageTimestamp: 1,
      }],
    });
    const singleEvents = single.runtime.drainMessages();
    assert.equal(singleEvents.length, 1);
    assert.equal(singleEvents[0].body, 'hello');
    assert.equal(Object.hasOwn(singleEvents[0], 'account'), false);

    const multi = harness(dir, { name: 'sales', multi: true, allowedUsers: '222' });
    await connect(multi);
    await multi.sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '111@s.whatsapp.net', fromMe: false, id: 'nope' },
          message: { conversation: 'wrong account' },
          pushName: 'Ada',
          messageTimestamp: 1,
        },
        {
          key: { remoteJid: '222@s.whatsapp.net', fromMe: false, id: 'yes' },
          message: { conversation: 'right account' },
          pushName: 'Bea',
          messageTimestamp: 2,
        },
      ],
    });
    const multiEvents = multi.runtime.drainMessages();
    assert.equal(multiEvents.length, 1);
    assert.equal(multiEvents[0].body, 'right account');
    assert.equal(multiEvents[0].account, 'sales');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pair-only exits after connect and exits when the first connect fails', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-rt-'));
  try {
    const ok = harness(dir, { pairOnly: true, name: 'sales', multi: true });
    await ok.runtime.start();
    await ok.sockets[0].emit('connection.update', { connection: 'open' });
    assert.deepEqual(ok.exits, []);
    await ok.clock.flush();
    assert.deepEqual(ok.exits, [0]);

    const bad = harness(dir, {
      pairOnly: true,
      deps: {
        async useMultiFileAuthState() {
          throw new Error('disk full');
        },
      },
    });
    await bad.runtime.start();
    assert.deepEqual(bad.exits, [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
