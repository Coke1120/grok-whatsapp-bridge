import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { proto } from '@whiskeysockets/baileys';
import { createAccountRuntime } from '../account_runtime.js';
import { parseAccessScopes, scopeForAccount } from '../access_scopes.js';

const DM = '111@s.whatsapp.net';
const OTHER = '222@s.whatsapp.net';
const GROUP = '333@g.us';
const PROVIDER_TIME = 1730000000;

function scope(fields = { readChats: [DM] }) {
  return scopeForAccount(parseAccessScopes(JSON.stringify({ default: fields })), 'default');
}

function message(id, chatId = DM, overrides = {}) {
  return {
    messageTimestamp: PROVIDER_TIME,
    message: { conversation: `fixture ${id}` },
    ...overrides,
    key: { remoteJid: chatId, id, fromMe: false, ...overrides.key },
  };
}

function fakeClock() {
  const timers = new Map();
  let next = 0;
  return {
    setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    async flush() {
      for (let i = 0; i < 10 && timers.size; i += 1) {
        const batch = [...timers.values()];
        timers.clear();
        for (const fn of batch) await fn();
      }
      assert.equal(timers.size, 0, 'fixture must not leave an unbounded timer loop');
    },
  };
}

function fakeSocket(options) {
  const handlers = new Map();
  const fake = {
    options,
    sent: [],
    receipts: [],
    presence: [],
    fetches: [],
    metadata: [],
    sendTimestamp: PROVIDER_TIME,
    historyResult: async () => 'provider-request-1',
    snapshot(event) { return [...(handlers.get(event) || [])]; },
    async emit(event, data) { for (const fn of fake.snapshot(event)) await fn(data); },
  };
  fake.sock = {
    user: { id: '15550001111:1@s.whatsapp.net', name: 'Synthetic fixture' },
    ev: {
      on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
      removeAllListeners(event) { if (event) handlers.delete(event); else handlers.clear(); },
    },
    async sendMessage(jid, payload, options) {
      fake.sent.push({ jid, payload, options });
      return message(`sent-${fake.sent.length}`, jid, {
        key: { fromMe: true }, messageTimestamp: fake.sendTimestamp,
        message: typeof payload.text === 'string' ? { conversation: payload.text } : payload,
      });
    },
    async fetchMessageHistory(...args) {
      fake.fetches.push(args);
      return fake.historyResult(...args);
    },
    async readMessages(keys) { fake.receipts.push(keys); },
    async sendPresenceUpdate(...args) { fake.presence.push(args); },
    async groupMetadata(jid) {
      fake.metadata.push(jid);
      return { subject: 'Fixture group', participants: [] };
    },
    async updateMediaMessage() {},
    async logout() {},
    end() {},
  };
  return fake;
}

function harness(t, overrides = {}, directory) {
  const dir = directory || mkdtempSync(path.join(tmpdir(), 'wa-history-runtime-'));
  const clock = fakeClock();
  const sockets = [];
  const downloads = [];
  const warnings = [];
  const runtime = createAccountRuntime({
    name: 'default', sessionDir: dir, mode: 'bot', multi: false,
    allowedUsers: '', groupAllowedUsers: '', groupPolicy: 'pairing', dmPolicy: 'open',
    accessScope: scope(), forwardOwnerMessages: false, sendReadReceipts: true,
    cacheDirs: { image: dir, audio: dir, document: dir },
    chunkDelayMs: 0, sendTimeoutMs: 1000,
    setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    log() {}, warn(line) { warnings.push(line); },
    deps: {
      async useMultiFileAuthState() { return { state: { creds: {} }, saveCreds() {} }; },
      makeWASocket(options) { const fake = fakeSocket(options); sockets.push(fake); return fake.sock; },
      async getWAVersion() { return [2, 3000, 1]; },
      async downloadMediaMessage(...args) { downloads.push(args); return Buffer.from('synthetic fixture'); },
      exitProcess() { assert.fail('fixture must not exit the process'); },
    },
    ...overrides,
  });
  t.after(async () => {
    await runtime.pause();
    if (!directory) rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, dir, clock, sockets, downloads, warnings,
    file: path.join(dir, 'conversation-history.json') };
}

async function connect(handle) {
  await handle.runtime.start();
  await handle.clock.flush();
  await handle.sockets.at(-1).emit('connection.update', { connection: 'open' });
  return handle.sockets.at(-1);
}

function cached(handle, chatId = DM, options) {
  const result = handle.runtime.chatMessages(chatId, options);
  assert.equal(result.status, 200);
  return result.body;
}

function assertPassive(handle, socket) {
  assert.deepEqual(handle.runtime.drainMessages(), []);
  assert.equal(handle.runtime.healthSnapshot().queueLength, 0);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.receipts, []);
  assert.deepEqual(socket.presence, []);
  assert.deepEqual(socket.fetches, []);
  assert.deepEqual(handle.downloads, []);
  assert.deepEqual(handle.warnings, []);
}

test('legacy and pairing-only runtimes do not enable or persist history', async (t) => {
  const legacy = harness(t, { accessScope: null });
  const socket = await connect(legacy);
  assert.equal(socket.options.syncFullHistory, false);
  assert.equal(socket.options.shouldSyncHistoryMessage(), false);
  await socket.emit('messaging-history.set', { chats: [{ id: DM }], messages: [message('legacy')] });
  await socket.emit('chats.upsert', [{ id: DM, name: 'Do not archive' }]);
  assert.equal(legacy.runtime.listChats().status, 403);
  assert.equal(legacy.runtime.chatMessages(DM).status, 403);
  assert.equal((await legacy.runtime.requestHistory(DM)).status, 403);
  assert.equal(existsSync(legacy.file), false);
  assertPassive(legacy, socket);

  const pairing = harness(t, { pairOnly: true, historyBackfillEnabled: true });
  assert.equal(pairing.runtime.listChats().status, 403);
  assert.equal((await pairing.runtime.requestHistory(DM)).status, 403);
  assert.equal(existsSync(pairing.file), false);
});

test('history sync and append cache scoped summaries without any live side effects', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM], triggerChats: [DM], sendChats: [DM] }) });
  const socket = await connect(handle);
  assert.equal(socket.options.syncFullHistory, false);
  assert.equal(socket.options.shouldSyncHistoryMessage(), true);
  await socket.emit('messaging-history.set', {
    chats: [{ id: DM, name: 'Permitted fixture' }, { id: OTHER, name: 'Forbidden fixture' }],
    messages: [message('sync'), message('forbidden-sync', OTHER)],
    isLatest: true,
  });
  await socket.emit('messages.upsert', { type: 'append', messages: [
    message('append', DM, { messageTimestamp: PROVIDER_TIME + 1 }),
    message('image', DM, { message: { imageMessage: { caption: 'Safe caption',
      url: 'https://example.invalid/private-image', mediaKey: Buffer.from('synthetic-key'),
      directPath: '/synthetic-private-path', contextInfo: { quotedMessage: { conversation: 'Private quote' } } } } }),
    message('forbidden-append', OTHER),
  ] });
  assert.deepEqual(cached(handle).messages.map((row) => row.messageId), ['append', 'sync', 'image']);
  assert.equal(cached(handle).complete, false);
  assert.equal(cached(handle).source, 'local-cache');
  assert.equal(handle.runtime.chatMessages(OTHER).status, 403);
  const chats = handle.runtime.listChats().body.chats;
  assert.deepEqual(chats.map((chat) => [chat.chatId, chat.name, chat.messageCount]), [[DM, 'Permitted fixture', 3]]);
  const saved = readFileSync(handle.file, 'utf8');
  for (const secret of ['private-image', 'synthetic-key', 'synthetic-private-path', 'Private quote', 'forbidden']) {
    assert.equal(saved.includes(secret), false, secret);
  }
  assert.equal(statSync(handle.file).mode & 0o777, 0o600);
  assertPassive(handle, socket);
});

test('chat upserts and updates retain only current permitted metadata', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM, GROUP] }) });
  const socket = await connect(handle);
  await socket.emit('chats.upsert', [{ id: DM, name: 'Before' }, { id: OTHER, name: 'Denied DM' }, { id: GROUP, name: 'Pairing denied group' }]);
  await socket.emit('chats.update', [{ id: DM, name: 'After' }]);
  assert.deepEqual(handle.runtime.listChats().body.chats, [{ chatId: DM, name: 'After', isGroup: false,
    lastMessageTimestamp: 0, messageCount: 0 }]);
  assert.equal(handle.runtime.chatMessages(GROUP).status, 403);
  assertPassive(handle, socket);
});

test('notify messages are cached without draining their live queue', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  await socket.emit('messages.upsert', { type: 'notify', messages: [message('live')] });
  assert.equal(handle.runtime.healthSnapshot().queueLength, 1);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(cached(handle).messages[0].messageId, 'live');
    assert.equal(handle.runtime.listChats().body.chats[0].messageCount, 1);
  }
  assert.equal(handle.runtime.healthSnapshot().queueLength, 1);
  assert.equal(handle.runtime.drainMessages()[0].messageId, 'live');
  assert.equal(cached(handle).messages[0].messageId, 'live');
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.receipts, []);
  assert.deepEqual(socket.presence, []);
});

test('a historical row replayed as notify cannot produce a live wake', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM], triggerChats: [DM], sendChats: [DM] }) });
  const socket = await connect(handle);
  const historical = message('replayed');
  await socket.emit('messaging-history.set', { messages: [historical] });
  await socket.emit('messages.upsert', { type: 'notify', messages: [historical] });
  await socket.emit('messages.upsert', { type: 'append', messages: [historical] });
  assert.equal(cached(handle).messages.length, 1);
  assertPassive(handle, socket);
});

test('owner notify messages are cached even when owner forwarding is disabled', async (t) => {
  const handle = harness(t, { forwardOwnerMessages: false });
  const socket = await connect(handle);
  await socket.emit('messages.upsert', { type: 'notify', messages: [message('owner', DM, { key: { fromMe: true } })] });
  const row = cached(handle).messages[0];
  assert.equal(row.messageId, 'owner');
  assert.equal(row.fromMe, true);
  assertPassive(handle, socket);
});

test('own sends are cached immediately only when their destination is also readable', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM], sendChats: [DM, OTHER] }) });
  const socket = await connect(handle);
  assert.equal((await handle.runtime.send({ chatId: DM, message: 'Permitted outgoing fixture' })).status, 200);
  assert.equal((await handle.runtime.send({ chatId: OTHER, message: 'Send-only fixture' })).status, 200);
  const rows = cached(handle).messages;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'Permitted outgoing fixture');
  assert.equal(rows[0].fromMe, true);
  assert.equal(rows[0].timestamp, PROVIDER_TIME);
  assert.equal(handle.runtime.chatMessages(OTHER).status, 403);
  assert.equal(readFileSync(handle.file, 'utf8').includes('Send-only fixture'), false);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(handle.runtime.drainMessages(), []);
});

test('undated own sends remain readable but cannot invent provider anchors', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM], sendChats: [DM] }), historyBackfillEnabled: true });
  const socket = await connect(handle);
  socket.sendTimestamp = undefined;
  assert.equal((await handle.runtime.send({ chatId: DM, message: 'Undated outgoing fixture' })).status, 200);
  assert.equal(cached(handle).messages.length, 1);
  assert.equal(cached(handle).messages[0].timestamp, 0);
  assert.equal((await handle.runtime.requestHistory(DM)).status, 409);
  assert.deepEqual(socket.fetches, []);
});

test('cache reads survive pause and restart without reading another account session', async (t) => {
  const first = harness(t, { name: 'first' });
  const second = harness(t, { name: 'second' });
  const socketA = await connect(first);
  const socketB = await connect(second);
  await socketA.emit('messaging-history.set', { messages: [message('account-a')] });
  await socketB.emit('messaging-history.set', { messages: [message('account-b')] });
  await first.runtime.pause();
  assert.equal(first.runtime.getStatus(), 'paused');
  assert.equal(cached(first).messages[0].messageId, 'account-a');
  const restored = harness(t, { name: 'first' }, first.dir);
  assert.equal(restored.runtime.getStatus(), 'disconnected');
  assert.equal(cached(restored).messages[0].messageId, 'account-a');
  assert.equal(cached(second).messages[0].messageId, 'account-b');
  assert.equal(JSON.parse(readFileSync(first.file, 'utf8')).account, 'first');
  assert.equal(readFileSync(first.file, 'utf8').includes('account-b'), false);
  assert.equal(readFileSync(second.file, 'utf8').includes('account-a'), false);
});

test('reloading narrower scope and pairing policy purges messages and metadata from disk', async (t) => {
  const initial = harness(t, { accessScope: scope({ readChats: [DM, OTHER, GROUP] }), groupPolicy: 'open' });
  const socket = await connect(initial);
  await socket.emit('messaging-history.set', { chats: [{ id: OTHER, name: 'Remove other' }, { id: GROUP, name: 'Remove group' }],
    messages: [message('keep'), message('remove-dm', OTHER), message('remove-group', GROUP)] });
  await initial.runtime.pause();
  const restricted = harness(t, { accessScope: scope({ readChats: [DM, GROUP] }), groupPolicy: 'pairing', historyBackfillEnabled: true }, initial.dir);
  assert.deepEqual(restricted.runtime.listChats().body.chats.map((chat) => chat.chatId), [DM]);
  assert.equal(restricted.runtime.chatMessages(OTHER).status, 403);
  assert.equal(restricted.runtime.chatMessages(GROUP).status, 403);
  assert.equal((await restricted.runtime.chatInfo(GROUP)).status, 403);
  assert.equal((await restricted.runtime.requestHistory(GROUP)).status, 403);
  const saved = readFileSync(restricted.file, 'utf8');
  assert.equal(saved.includes('remove-dm'), false);
  assert.equal(saved.includes('remove-group'), false);
  assert.equal(saved.includes('Remove other'), false);
  assert.equal(saved.includes('Remove group'), false);
});

test('group history needs both explicit read scope and an admitting group policy', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [GROUP] }), groupPolicy: 'allowlist',
    groupAllowedUsers: '333', historyBackfillEnabled: true });
  const socket = await connect(handle);
  const anchor = message('group-anchor', GROUP, { key: { participant: DM } });
  await socket.emit('messaging-history.set', { chats: [{ id: GROUP, subject: 'Permitted group' }], messages: [anchor] });
  assert.equal(cached(handle, GROUP).messages[0].senderId, DM);
  assert.deepEqual(handle.runtime.listChats({ groups: '0' }).body.chats, []);
  assert.equal(handle.runtime.listChats({ groups: '1' }).body.chats[0].name, 'Permitted group');
  const result = await handle.runtime.requestHistory(GROUP);
  assert.equal(result.status, 202);
  assert.deepEqual(socket.fetches[0], [20, anchor.key, PROVIDER_TIME]);
});

test('group policy blocks metadata, messages, and history provider contact despite read grant', async (t) => {
  for (const groupPolicy of ['pairing', 'disabled', 'allowlist']) {
    const handle = harness(t, { accessScope: scope({ readChats: [GROUP] }), groupPolicy,
      groupAllowedUsers: '444', historyBackfillEnabled: true });
    const socket = await connect(handle);
    await socket.emit('messaging-history.set', { chats: [{ id: GROUP, name: 'Denied' }], messages: [message('denied', GROUP)] });
    assert.deepEqual(handle.runtime.listChats().body.chats, []);
    assert.equal(handle.runtime.chatMessages(GROUP).status, 403);
    assert.equal((await handle.runtime.chatInfo(GROUP)).status, 403);
    assert.equal((await handle.runtime.requestHistory(GROUP)).status, 403);
    assert.deepEqual(socket.metadata, []);
    assertPassive(handle, socket);
  }
});

test('pagination binds cursors to account, collection, filter, and cache revision', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM, OTHER, GROUP] }), groupPolicy: 'open' });
  const socket = await connect(handle);
  await socket.emit('messaging-history.set', { messages: [
    message('newer', DM, { messageTimestamp: PROVIDER_TIME + 2 }), message('older', DM),
    message('other', OTHER, { messageTimestamp: PROVIDER_TIME + 1 }), message('group', GROUP),
  ] });
  const first = cached(handle, DM, { limit: '1' });
  assert.equal(first.messages[0].messageId, 'newer');
  assert.equal(cached(handle, DM, { limit: 1, cursor: first.nextCursor }).messages[0].messageId, 'older');
  assert.throws(() => cached(handle, OTHER, { limit: 1, cursor: first.nextCursor }), { status: 400 });
  const [data, signature] = first.nextCursor.split('.');
  const tampered = `${data}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.throws(() => cached(handle, DM, { cursor: tampered }), { status: 400 });
  const chats = handle.runtime.listChats({ limit: 1, groups: '0' }).body;
  assert.equal(chats.chats[0].chatId, DM);
  assert.throws(() => handle.runtime.listChats({ limit: 1, groups: '1', cursor: chats.nextCursor }), { status: 400 });
  assert.throws(() => handle.runtime.listChats({ cursor: first.nextCursor }), { status: 400 });
  const otherAccount = harness(t, { name: 'different' });
  assert.throws(() => cached(otherAccount, DM, { cursor: first.nextCursor }), { status: 400 });
  await socket.emit('messages.upsert', { type: 'append', messages: [message('changed')] });
  assert.throws(() => cached(handle, DM, { cursor: first.nextCursor }), { status: 409 });
  for (const limit of [0, -1, 101, 1.5, '01', 'all', [], null]) {
    assert.throws(() => cached(handle, DM, { limit }), { status: 400 });
  }
  assert.throws(() => handle.runtime.listChats({ groups: 'all' }), { status: 400 });
});

test('backfill is off by default and never contacts the provider when disabled or out of scope', async (t) => {
  const disabled = harness(t);
  const disabledSocket = await connect(disabled);
  await disabledSocket.emit('messaging-history.set', { messages: [message('anchor')] });
  assert.equal((await disabled.runtime.requestHistory(DM)).status, 403);
  assertPassive(disabled, disabledSocket);

  const handle = harness(t, { accessScope: scope({ sendChats: [DM], triggerChats: [DM] }), historyBackfillEnabled: true });
  const socket = await connect(handle);
  await socket.emit('messaging-history.set', { messages: [message('denied-anchor')] });
  assert.equal((await handle.runtime.requestHistory(DM)).status, 403);
  assert.deepEqual(handle.runtime.listChats().body.chats, []);
  assertPassive(handle, socket);
});

test('read-only backfill uses the oldest dated cached anchor with the provider timestamp unchanged', async (t) => {
  const handle = harness(t, { historyBackfillEnabled: true });
  const socket = await connect(handle);
  const oldest = message('oldest', DM, { messageTimestamp: PROVIDER_TIME - 100 });
  await socket.emit('messaging-history.set', { messages: [
    message('newest'), oldest, message('undated', DM, { messageTimestamp: undefined }),
  ] });
  const result = await handle.runtime.requestHistory(DM, { count: 50 });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { requested: true, requestId: 'provider-request-1', chatId: DM,
    count: 50, complete: false, source: 'provider-request', status: 'requested' });
  assert.deepEqual(socket.fetches, [[50, oldest.key, PROVIDER_TIME - 100]]);
  assert.equal(cached(handle).messages.length, 3, 'request acceptance does not imply history completion');
  assert.deepEqual(handle.runtime.drainMessages(), []);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.receipts, []);
  assert.deepEqual(socket.presence, []);
});

test('backfill validates count and refuses caller-supplied anchors before provider contact', async (t) => {
  const handle = harness(t, { historyBackfillEnabled: true });
  const socket = await connect(handle);
  await socket.emit('messaging-history.set', { messages: [message('anchor')] });
  for (const body of [null, [], 'invalid', false, { count: 0 }, { count: 51 }, { count: -1 }, { count: 1.5 }, { count: '20' },
    { key: message('forged').key }, { messageTimestamp: 1 }, { count: 20, chatId: OTHER },
    { count: 20, oldestMsgKey: message('forged').key }]) {
    assert.equal((await handle.runtime.requestHistory(DM, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(socket.fetches, []);
  assert.equal((await handle.runtime.requestHistory(DM)).status, 202);
  assert.equal(socket.fetches[0][0], 20);
});

test('empty, undated, and disconnected caches never cause provider backfill contact', async (t) => {
  const handle = harness(t, { historyBackfillEnabled: true });
  const socket = await connect(handle);
  assert.equal((await handle.runtime.requestHistory(DM)).status, 409);
  await socket.emit('messaging-history.set', { messages: [message('undated', DM, { messageTimestamp: undefined })] });
  assert.equal((await handle.runtime.requestHistory(DM)).status, 409);
  delete socket.sock.fetchMessageHistory;
  assert.equal((await handle.runtime.requestHistory(DM)).status, 503);
  await handle.runtime.pause();
  assert.equal((await handle.runtime.requestHistory(DM)).status, 503);
  assert.deepEqual(socket.fetches, []);
  assert.equal(cached(handle).messages[0].timestamp, 0);
});

test('backfill cooldown is 60 seconds per account rather than per chat', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const handle = harness(t, { accessScope: scope({ readChats: [DM, OTHER] }), historyBackfillEnabled: true });
  const socket = await connect(handle);
  await socket.emit('messaging-history.set', { messages: [message('anchor'), message('other-anchor', OTHER)] });
  assert.equal((await handle.runtime.requestHistory(DM)).status, 202);
  assert.equal((await handle.runtime.requestHistory(OTHER)).status, 429);
  now += 59999;
  assert.equal((await handle.runtime.requestHistory(DM)).status, 429);
  assert.equal(socket.fetches.length, 1);
  now += 1;
  assert.equal((await handle.runtime.requestHistory(OTHER)).status, 202);
  assert.equal(socket.fetches.length, 2);
});

test('backfill uncertainty consumes cooldown and never retries automatically', async (t) => {
  for (const historyResult of [async () => { throw new Error('synthetic transport failure'); }, async () => undefined, async () => '']) {
    const handle = harness(t, { historyBackfillEnabled: true });
    const socket = await connect(handle);
    socket.historyResult = historyResult;
    await socket.emit('messaging-history.set', { messages: [message('anchor')] });
    const result = await handle.runtime.requestHistory(DM);
    assert.equal(result.status, 503);
    assert.match(result.body.error, /uncertain/i);
    assert.match(result.body.error, /do not retry automatically/i);
    await handle.clock.flush();
    assert.equal(socket.fetches.length, 1);
    assert.equal((await handle.runtime.requestHistory(DM)).status, 429);
    assert.equal(socket.fetches.length, 1);
  }
});

test('pending requests are single-flight and a socket replacement makes acceptance uncertain', async (t) => {
  const handle = harness(t, { historyBackfillEnabled: true });
  const old = await connect(handle);
  let resolveRequest;
  old.historyResult = () => new Promise((resolve) => { resolveRequest = resolve; });
  await old.emit('messaging-history.set', { messages: [message('anchor')] });
  const pending = handle.runtime.requestHistory(DM);
  assert.equal((await handle.runtime.requestHistory(DM)).status, 429);
  await handle.runtime.pause();
  await handle.runtime.resume();
  await handle.clock.flush();
  const current = handle.sockets.at(-1);
  await current.emit('connection.update', { connection: 'open' });
  resolveRequest('old-socket-request');
  assert.equal((await pending).status, 503);
  assert.equal(old.fetches.length, 1);
  assert.deepEqual(current.fetches, []);
});

test('callbacks retained from a stale socket cannot write history or live events', async (t) => {
  const handle = harness(t);
  const old = await connect(handle);
  await old.emit('messaging-history.set', { messages: [message('keep')] });
  const stale = ['messaging-history.set', 'chats.upsert', 'chats.update', 'messages.upsert', 'messages.update', 'messages.delete']
    .map((event) => [event, old.snapshot(event)]);
  await handle.runtime.pause();
  await handle.runtime.resume();
  await handle.clock.flush();
  const current = handle.sockets.at(-1);
  await current.emit('connection.update', { connection: 'open' });
  const payloads = {
    'messaging-history.set': { messages: [message('stale-sync')], chats: [{ id: DM, name: 'Stale sync' }] },
    'chats.upsert': [{ id: DM, name: 'Stale upsert' }],
    'chats.update': [{ id: DM, name: 'Stale update' }],
    'messages.upsert': { type: 'notify', messages: [message('stale-notify')] },
    'messages.update': [{ key: message('keep').key, update: { message: { conversation: 'Stale edit' } } }],
    'messages.delete': { keys: [message('keep').key] },
  };
  for (const [event, callbacks] of stale) for (const callback of callbacks) await callback(payloads[event]);
  assert.deepEqual(cached(handle).messages.map((row) => row.messageId), ['keep']);
  assert.equal(readFileSync(handle.file, 'utf8').includes('Stale'), false);
  assertPassive(handle, current);
});

test('provider edits and deletions update the cache without adding live events', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  await socket.emit('messaging-history.set', { messages: [message('edit'), message('delete')] });
  await socket.emit('messages.update', [{ key: message('edit').key,
    update: { message: { conversation: 'Edited fixture' } } }]);
  const edited = cached(handle).messages.find((row) => row.messageId === 'edit');
  assert.equal(edited.body, 'Edited fixture');
  assert.equal(edited.timestamp, PROVIDER_TIME);
  await socket.emit('messages.delete', { keys: [message('delete').key] });
  assert.deepEqual(cached(handle).messages.map((row) => row.messageId), ['edit']);
  await socket.emit('messages.delete', { all: true, jid: DM });
  assert.deepEqual(cached(handle).messages, []);
  assert.deepEqual(handle.runtime.listChats().body.chats, []);
  assertPassive(handle, socket);
});

test('history sync accepts ON_DEMAND but rejects FULL at both socket and event boundaries', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  const { FULL, ON_DEMAND } = proto.HistorySync.HistorySyncType;
  assert.equal(FULL, 2);
  assert.equal(ON_DEMAND, 6);
  assert.equal(socket.options.shouldSyncHistoryMessage({ syncType: FULL }), false);
  assert.equal(socket.options.shouldSyncHistoryMessage({ syncType: ON_DEMAND }), true);
  await socket.emit('messaging-history.set', { syncType: FULL,
    chats: [{ id: DM, name: 'Rejected full-sync metadata' }], messages: [message('full-sync-only')] });
  assert.deepEqual(handle.runtime.listChats().body.chats, []);
  assert.equal(existsSync(handle.file), false);
  await socket.emit('messaging-history.set', { syncType: ON_DEMAND,
    chats: [{ id: DM, name: 'On-demand fixture' }], messages: [message('on-demand')] });
  assert.equal(cached(handle).messages[0].messageId, 'on-demand');
  assert.equal(handle.runtime.listChats().body.chats[0].name, 'On-demand fixture');
  assert.equal(readFileSync(handle.file, 'utf8').includes('full-sync'), false);
  assertPassive(handle, socket);

  const legacy = harness(t, { accessScope: null });
  const legacySocket = await connect(legacy);
  assert.equal(legacySocket.options.shouldSyncHistoryMessage({ syncType: ON_DEMAND }), false);
  assert.equal(legacySocket.options.shouldSyncHistoryMessage({ syncType: FULL }), false);
});

test('historical unsupported and ephemeral keys suppress notify replay after restart without storing their bodies', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM], triggerChats: [DM], sendChats: [DM] }) });
  const socket = await connect(handle);
  const hidden = [
    message('ephemeral-sync', DM, { message: { ephemeralMessage: { message: { conversation: 'PRIVATE_EPHEMERAL_FIXTURE' } } } }),
    message('unsupported-sync', DM, { message: { contactMessage: { displayName: 'PRIVATE_CONTACT_FIXTURE', vcard: 'PRIVATE_VCARD_FIXTURE' } } }),
    message('view-once-append', DM, { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'PRIVATE_VIEW_ONCE_FIXTURE' } } } } }),
    message('unsupported-append', DM, { message: { locationMessage: { name: 'PRIVATE_LOCATION_FIXTURE', degreesLatitude: 1, degreesLongitude: 2 } } }),
  ];
  await socket.emit('messaging-history.set', { messages: hidden.slice(0, 2), syncType: 6 });
  await socket.emit('messages.upsert', { type: 'append', messages: hidden.slice(2) });
  assert.deepEqual(cached(handle).messages, []);
  const saved = readFileSync(handle.file, 'utf8');
  assert.equal(saved.includes('PRIVATE_'), false);
  for (const row of hidden) assert.equal(saved.includes(row.key.id), false, 'body-free markers must not retain plaintext message IDs');
  assertPassive(handle, socket);
  await handle.runtime.pause();

  const restored = harness(t, { accessScope: scope({ readChats: [DM], triggerChats: [DM], sendChats: [DM] }) }, handle.dir);
  const current = await connect(restored);
  await current.emit('messages.upsert', { type: 'notify', messages: hidden });
  assert.deepEqual(cached(restored).messages, []);
  assert.equal(readFileSync(restored.file, 'utf8').includes('PRIVATE_'), false);
  await current.emit('messages.upsert', { type: 'notify', messages: [
    message('unsupported-sync'), message('unsupported-append'),
  ] });
  assertPassive(restored, current);
});

test('historical replay suppression survives summary eviction and a restart', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  const evicted = message('old-historical-evicted', DM, { messageTimestamp: PROVIDER_TIME - 1000,
    message: { conversation: 'EVICTED_PRIVATE_BODY' } });
  await socket.emit('messaging-history.set', { messages: [evicted] });
  await socket.emit('messages.upsert', { type: 'append', messages: Array.from({ length: 500 }, (_, index) =>
    message(`retained-${String(index).padStart(3, '0')}`, DM, { messageTimestamp: PROVIDER_TIME + index })) });
  assert.equal(handle.runtime.listChats().body.chats[0].messageCount, 500);
  assert.equal(cached(handle).truncated, true);
  const saved = readFileSync(handle.file, 'utf8');
  assert.equal(saved.includes(evicted.key.id), false);
  assert.equal(saved.includes('EVICTED_PRIVATE_BODY'), false);
  assertPassive(handle, socket);
  await handle.runtime.pause();

  const restored = harness(t, {}, handle.dir);
  const current = await connect(restored);
  await current.emit('messages.upsert', { type: 'notify', messages: [evicted] });
  assert.equal(restored.runtime.listChats().body.chats[0].messageCount, 500);
  assert.equal(readFileSync(restored.file, 'utf8').includes('EVICTED_PRIVATE_BODY'), false);
  assertPassive(restored, current);
});

test('deleted-key markers prevent resurrection by sync, append, notify, or edits after restart', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM, OTHER] }) });
  const socket = await connect(handle);
  const known = message('deleted-known');
  const unseen = message('deleted-before-arrival');
  await socket.emit('messaging-history.set', { messages: [known] });
  await socket.emit('messages.delete', { keys: [known.key, unseen.key] });
  assert.deepEqual(cached(handle).messages, []);
  assert.equal(readFileSync(handle.file, 'utf8').includes('deleted-known'), false);
  await handle.runtime.pause();

  const restored = harness(t, { accessScope: scope({ readChats: [DM, OTHER] }) }, handle.dir);
  const current = await connect(restored);
  for (const type of ['notify', 'append']) {
    await current.emit('messages.upsert', { type, messages: [known, unseen] });
    assert.deepEqual(cached(restored).messages, []);
    assert.deepEqual(restored.runtime.drainMessages(), []);
  }
  await current.emit('messaging-history.set', { messages: [known, unseen], syncType: 6 });
  await current.emit('messages.update', [known, unseen].map((row) => ({ key: row.key,
    update: { message: { conversation: 'Deleted content must not return' }, messageTimestamp: PROVIDER_TIME + 1 } })));
  assert.deepEqual(cached(restored).messages, []);
  assert.equal(readFileSync(restored.file, 'utf8').includes('Deleted content must not return'), false);
  assertPassive(restored, current);

  await current.emit('messages.upsert', { type: 'notify', messages: [message(unseen.key.id, OTHER)] });
  assert.equal(cached(restored, OTHER).messages[0].messageId, unseen.key.id);
  assert.deepEqual(restored.runtime.drainMessages().map((row) => row.chatId), [OTHER],
    'a deletion marker is scoped to its original chat');
});

test('deleting all cached chat messages persists a deletion marker for every removed key', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  const rows = [message('all-delete-a'), message('all-delete-b')];
  await socket.emit('messaging-history.set', { messages: rows });
  await socket.emit('messages.delete', { all: true, jid: DM });
  assert.deepEqual(handle.runtime.listChats().body.chats, []);
  await handle.runtime.pause();
  const restored = harness(t, {}, handle.dir);
  const current = await connect(restored);
  await current.emit('messaging-history.set', { messages: rows });
  await current.emit('messages.upsert', { type: 'notify', messages: rows });
  assert.deepEqual(cached(restored).messages, []);
  assertPassive(restored, current);
});

test('rc13 revoke updates delete the outer target key rather than the revoke-event key', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  const target = message('rc13-target');
  const event = message('rc13-revoke-event');
  assert.equal(proto.WebMessageInfo.StubType.REVOKE, 1);
  await socket.emit('messaging-history.set', { messages: [target, event] });
  await socket.emit('messages.update', [{ key: target.key,
    update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE, key: event.key } }]);
  assert.deepEqual(cached(handle).messages.map((row) => row.messageId), [event.key.id]);
  await socket.emit('messages.update', [{ key: target.key,
    update: { key: event.key, message: { conversation: 'Do not resurrect the revoked target' } } }]);
  assert.deepEqual(cached(handle).messages.map((row) => row.messageId), [event.key.id]);
  assert.equal(cached(handle).messages[0].body, event.message.conversation);
  await handle.runtime.pause();
  const restored = harness(t, {}, handle.dir);
  const current = await connect(restored);
  await current.emit('messaging-history.set', { messages: [target] });
  await current.emit('messages.upsert', { type: 'notify', messages: [target] });
  assert.deepEqual(cached(restored).messages.map((row) => row.messageId), [event.key.id]);
  assertPassive(restored, current);
});

test('raw protocol revokes accept an omitted target chat but reject conflicting chat authority', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM, OTHER] }) });
  const socket = await connect(handle);
  const target = message('raw-target');
  await socket.emit('messaging-history.set', { messages: [target, message(target.key.id, OTHER)] });
  await socket.emit('messages.upsert', { type: 'append', messages: [message('conflicting-revoke', DM, {
    message: { protocolMessage: { type: 0, key: { id: target.key.id, remoteJid: OTHER, fromMe: false } } },
  })] });
  assert.equal(cached(handle).messages.length, 1);
  assert.equal(cached(handle, OTHER).messages.length, 1);
  await socket.emit('messaging-history.set', { messages: [message('omitted-chat-revoke', DM, {
    message: { protocolMessage: { type: 0, key: { id: target.key.id, fromMe: false } } },
  })] });
  assert.deepEqual(cached(handle).messages, []);
  assert.equal(cached(handle, OTHER).messages[0].messageId, target.key.id);
  await socket.emit('messages.upsert', { type: 'append', messages: [target] });
  await socket.emit('messages.upsert', { type: 'notify', messages: [target] });
  assert.deepEqual(cached(handle).messages, []);
  assertPassive(handle, socket);
});

test('null-message REVOKE stubs in history and append permanently delete their target keys', async (t) => {
  const handle = harness(t);
  const socket = await connect(handle);
  const historyTarget = message('history-stub-target');
  const appendTarget = message('append-stub-target');
  await socket.emit('messaging-history.set', { messages: [historyTarget, appendTarget] });
  const stub = (row) => ({ ...row, message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE });
  await socket.emit('messaging-history.set', { messages: [stub(historyTarget)] });
  assert.deepEqual(cached(handle).messages.map((row) => row.messageId), [appendTarget.key.id]);
  await socket.emit('messages.upsert', { type: 'append', messages: [stub(appendTarget)] });
  assert.deepEqual(cached(handle).messages, []);
  await handle.runtime.pause();
  const restored = harness(t, {}, handle.dir);
  const current = await connect(restored);
  await current.emit('messaging-history.set', { messages: [historyTarget, appendTarget] });
  await current.emit('messages.upsert', { type: 'notify', messages: [historyTarget, appendTarget] });
  assert.deepEqual(cached(restored).messages, []);
  assertPassive(restored, current);
});

test('a timed-out backfill remains single-flight until the provider really settles', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['resolve', 'reject']) {
    const handle = harness(t, { historyBackfillEnabled: true });
    const socket = await connect(handle);
    let settle;
    socket.historyResult = () => new Promise((resolve, reject) => {
      settle = () => outcome === 'resolve' ? resolve('late-provider-request') : reject(new Error('late synthetic failure'));
    });
    await socket.emit('messaging-history.set', { messages: [message(`timeout-anchor-${outcome}`)] });
    const pending = handle.runtime.requestHistory(DM);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.fetches.length, 1);
    t.mock.timers.tick(5000);
    const timedOut = await pending;
    assert.equal(timedOut.status, 503);
    assert.match(timedOut.body.error, /uncertain/i);
    assert.match(timedOut.body.error, /do not retry automatically/i);
    now += 60001;
    assert.equal((await handle.runtime.requestHistory(DM)).status, 429,
      'elapsed cooldown cannot authorize another request while the original provider promise remains pending');
    assert.equal(socket.fetches.length, 1);
    settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.fetches.length, 1, 'late settlement must not start a retry');
    socket.historyResult = async () => 'new-explicit-provider-request';
    const explicit = await handle.runtime.requestHistory(DM);
    assert.equal(explicit.status, 202);
    assert.equal(explicit.body.requestId, 'new-explicit-provider-request');
    assert.equal(socket.fetches.length, 2);
    assert.equal((await handle.runtime.requestHistory(DM)).status, 429);
    assert.deepEqual(handle.runtime.drainMessages(), []);
  }
});

test('historical ingestion continues and keys remain marked after row-100 persistence failure', async (t) => {
  const handle = harness(t, { accessScope: scope({ readChats: [DM], triggerChats: [DM], sendChats: [DM] }) });
  const socket = await connect(handle);
  mkdirSync(handle.file);
  const rows = Array.from({ length: 150 }, (_, index) => message(`failed-write-${index}`, DM,
    { messageTimestamp: PROVIDER_TIME + index }));
  await socket.emit('messaging-history.set', { messages: rows, syncType: 6 });
  assert.equal(handle.warnings.length, 1);
  assert.match(handle.warnings[0], /cache could not be updated/i);
  assert.equal(statSync(handle.file).isDirectory(), true);
  assert.equal(cached(handle, DM, { limit: 100 }).messages.some((row) => row.messageId === 'failed-write-149'), true,
    'a persistence failure must not prevent in-memory tail processing');
  const withTailRevoke = [...rows.slice(0, 100), message('tail-revoke', DM, { message: { protocolMessage: { type: 0, key: rows[149].key } } })];
  await socket.emit('messaging-history.set', { messages: withTailRevoke, syncType: 6 });
  assert.equal(cached(handle, DM, { limit: 100 }).messages.some((row) => row.messageId === 'failed-write-149'), false,
    'a tail REVOKE must still remove cached text after an intermediate write failure');
  await socket.emit('messages.upsert', { type: 'notify', messages: [rows[149]] });
  assert.deepEqual(handle.runtime.drainMessages(), [], 'a historical tail key cannot wake the listener');
  assert.equal(handle.runtime.healthSnapshot().queueLength, 0);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.receipts, []);
  assert.deepEqual(socket.presence, []);
  assert.deepEqual(socket.fetches, []);
  assert.deepEqual(handle.downloads, []);
});
