import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInboxListener } from '../listener.mjs';
import { parseAccessScopes, scopeForAccount } from '../access_scopes.js';
import { saveListenerState, deliveryIdentity } from '../listener_delivery.mjs';
import { readRecentInbox } from '../mcp/tools.mjs';

const event = (id = 'm1', chatId = '111@s.whatsapp.net') => ({ scopeVersion: 1, eventType: 'message', fromOwner: false, messageId: id, chatId, senderId: '111@s.whatsapp.net', body: 'hello' });
const response = (status = 200, payload = {}) => ({ status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(payload); } });
function setup(t, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = {
    apiToken: 'fixture-bridge-token-not-a-secret-0001',
    accounts: [{ name: 'default', allowedUsers: '111', accessScope: extra.defaultAck
      ? scopeForAccount(parseAccessScopes(JSON.stringify({ default: { readChats: ['111@s.whatsapp.net'], triggerChats: ['111@s.whatsapp.net'], sendChats: ['111@s.whatsapp.net'] } })), 'default') : null }],
    defaultWakeUrl: 'https://example.invalid/wake', defaultWakeAuth: 'secret-token',
    inboxPath: path.join(dir, 'inbox.jsonl'), statePath: path.join(dir, 'listener-state.json'),
    unreadFlagPath: path.join(dir, 'unread.flag'), log() {}, warn() {}, ...extra,
  };
  return { dir, options, state: () => JSON.parse(readFileSync(options.statePath, 'utf8')) };
}

test('real message ID and stable delivery ID reach inbox, MCP and webhook', async (t) => {
  let wake;
  const x = setup(t, { fetch: async (url, options) => {
    if (url.endsWith('/messages')) return response(200, [event()]);
    wake = options;
    return response();
  } });
  await createInboxListener(x.options).tick();
  const row = JSON.parse(readFileSync(x.options.inboxPath, 'utf8'));
  const payload = JSON.parse(wake.body);
  assert.equal(row.messageId, 'm1');
  assert.equal(payload.messageId, 'm1');
  assert.equal(payload.deliveryId, row.deliveryId);
  assert.equal(wake.headers['Idempotency-Key'], row.deliveryId);
  assert.equal(wake.redirect, 'manual');
  const mcp = await readRecentInbox(x.options.inboxPath, new Set([event().chatId]));
  assert.equal(mcp[0].messageId, 'm1');
  assert.equal(mcp[0].deliveryId, payload.deliveryId);
  assert.equal(x.state().pendingWakes.length, 0);
});

test('outbox commits event before transmission, excludes credentials, and retries after restart', async (t) => {
  let time = 1000;
  const wakes = [];
  const x = setup(t, { now: () => time, wakeRetryEnabled: true, wakeRetryDelays: [10], fetch: async (url, opts) => {
    if (url.endsWith('/messages')) return response(200, [event()]);
    const saved = x.state();
    assert.equal(saved.pendingWakes[0].status, 'in_flight');
    assert.equal(saved.pendingWakes[0].attempts, wakes.length + 1);
    assert.equal(saved.seen[0], saved.pendingWakes[0].deliveryId);
    assert.doesNotMatch(readFileSync(x.options.statePath, 'utf8'), /secret-token|example.invalid/);
    wakes.push(opts);
    return response(wakes.length === 1 ? 503 : 200);
  } });
  await createInboxListener(x.options).tick();
  assert.equal(wakes.length, 1);
  assert.equal(x.state().pendingWakes[0].status, 'pending');
  time += 9;
  await createInboxListener(x.options).tick();
  assert.equal(wakes.length, 1);
  time += 1;
  await createInboxListener(x.options).tick();
  assert.equal(wakes.length, 2);
  assert.equal(wakes[0].headers['Idempotency-Key'], wakes[1].headers['Idempotency-Key']);
  assert.equal(wakes[0].body, wakes[1].body);
  assert.equal(readFileSync(x.options.inboxPath, 'utf8').trim().split('\n').length, 1);
});

test('repeated source events do not cause duplicate wakes, even after restart', async (t) => {
  let sent = 0;
  const x = setup(t, { fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, [event(), event()]);
    sent++; return response();
  } });
  await createInboxListener(x.options).tick();
  await createInboxListener(x.options).tick();
  assert.equal(sent, 1);
});

test('same message ID from different accounts or chats has a distinct delivery key', () => {
  assert.notEqual(deliveryIdentity('ops', '111@lid', 'id'), deliveryIdentity('sales', '111@lid', 'id'));
  assert.notEqual(deliveryIdentity('ops', '111@lid', 'id'), deliveryIdentity('ops', '222@lid', 'id'));
});

test('retry caps and permanent failures remain recorded for review without automatic replay', async (t) => {
  for (const status of [401, 403, 302, 503, 429]) {
    let time = 0; let sent = 0;
    const x = setup(t, { now: () => time, wakeRetryEnabled: true, wakeMaxAttempts: 2, wakeRetryDelays: [5], fetch: async (url) => {
      if (url.endsWith('/messages')) return response(200, [event()]);
      sent++; return response(status);
    } });
    const listener = createInboxListener(x.options);
    await listener.tick(); time += 5; await listener.tick(); time += 5; await listener.tick();
    assert.equal(sent, status >= 500 || status === 429 ? 2 : 1);
    assert.equal(x.state().pendingWakes[0].status, 'failed');
  }
});

test('network failure is retained and is not retried by default', async (t) => {
  let sent = 0;
  const x = setup(t, { fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, [event()]);
    sent++; throw new Error('failed request including private URL and bearer');
  } });
  await createInboxListener(x.options).tick();
  await createInboxListener(x.options).tick();
  assert.equal(sent, 1);
  assert.equal(x.state().pendingWakes[0].status, 'needs_review');
  assert.equal(x.state().pendingWakes[0].lastFailure, 'network_or_timeout');
});

test('interrupted in-flight request only retries when idempotent receiver opt-in is enabled', async (t) => {
  let sent = 0;
  const x = setup(t, { fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, [event()]);
    sent++; throw new Error('timeout');
  } });
  await createInboxListener(x.options).tick();
  const state = x.state(); state.pendingWakes[0].status = 'in_flight';
  saveListenerState(x.options.statePath, state);
  await createInboxListener(x.options).tick();
  assert.equal(sent, 1);
  assert.equal(x.state().pendingWakes[0].status, 'needs_review');
  saveListenerState(x.options.statePath, state);
  await createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...x.options, wakeRetryEnabled: true, fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, []);
    sent++; return response();
  } }).tick();
  assert.equal(sent, 2);
  assert.equal(x.state().pendingWakes.length, 0);
});

test('removed allowlist or changed destination blocks stale deliveries', async (t) => {
  for (const changed of [{ accounts: [{ name: 'default', allowedUsers: '' }] }, { defaultWakeUrl: 'https://other.invalid/wake' }, { defaultWakeAuth: 'changed-token' }]) {
    let sent = 0;
    const x = setup(t, { now: () => 0, wakeRetryEnabled: true, wakeRetryDelays: [1], fetch: async (url) => {
      if (url.endsWith('/messages')) return response(200, [event()]);
      sent++; return response(503);
    } });
    await createInboxListener(x.options).tick();
    await createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...x.options, ...changed, now: () => 2 }).tick();
    assert.equal(sent, 1);
    assert.equal(x.state().pendingWakes[0].status, 'blocked');
  }
});

test('expired events are not replayed and full outbox pauses destructive intake', async (t) => {
  let time = 0; let polls = 0; let sent = 0;
  const x = setup(t, { now: () => time, wakeRetryEnabled: true, wakeRetryDelays: [1], maxWakeAgeMs: 10, outboxLimit: 1, fetch: async (url) => {
    if (url.endsWith('/messages')) { polls++; return response(200, [event()]); }
    sent++; return response(503);
  } });
  const listener = createInboxListener(x.options);
  await listener.tick(); time = 11; await listener.tick();
  assert.equal(polls, 1);
  assert.equal(sent, 1);
  assert.equal(x.state().pendingWakes[0].status, 'failed');
});

test('corrupt state fails closed instead of resetting dedup history', (t) => {
  const x = setup(t);
  for (const value of ['{broken', '{}', ...[42, {}, null].map((id) => JSON.stringify({ seen: [id], acked: 0, processed: 0 })), JSON.stringify({ seen: [], acked: 0, processed: 0, uncertainAcks: null }), JSON.stringify({ seen: [], acked: 0, processed: 0, pendingWakes: [{}] })]) {
    writeFileSync(x.options.statePath, value);
    assert.throws(() => createInboxListener(x.options), /state|outbox|acknowledgement history/i);
    assert.equal(readFileSync(x.options.statePath, 'utf8'), value);
  }
});

test('state is atomically replaced with private mode and no leftover temp file', (t) => {
  const x = setup(t);
  saveListenerState(x.options.statePath, { seen: [], acked: 0, processed: 0 });
  saveListenerState(x.options.statePath, { seen: ['id'], acked: 0, processed: 1 });
  assert.deepEqual(x.state().seen, ['id']);
  assert.equal(statSync(x.options.statePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(x.dir), ['listener-state.json']);
});

test('actual hanging webhook aborts, redirects are not followed, bearer never reaches redirect target', async (t) => {
  const received = [];
  let mode = 'hang';
  const server = createServer((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/target') { res.end('must not reach'); return; }
    if (mode === 'redirect') { res.writeHead(307, { Location: '/target' }); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const x = setup(t, { // Leave time for the real loopback handshake on CPU-limited test runners.
    defaultWakeUrl: `http://127.0.0.1:${server.address().port}/wake`, wakeTimeoutMs: 1000, fetch: async (url, options) => {
    if (url.endsWith('/messages')) return response(200, [event(mode)]);
    return fetch(url, options);
  } });
  await createInboxListener(x.options).tick();
  assert.equal(x.state().pendingWakes[0].status, 'needs_review');
  mode = 'redirect';
  await createInboxListener(x.options).tick();
  assert.deepEqual(received, [
    { path: '/wake', authorization: 'Bearer secret-token' },
    { path: '/wake', authorization: 'Bearer secret-token' },
  ]);
  assert.equal(x.state().pendingWakes.length, 2);
  assert.equal(x.state().pendingWakes[1].status, 'failed');
  assert.equal(x.state().pendingWakes[1].lastFailure, 'http_307');
});

test('turning retries off retains a scheduled attempt for review', async (t) => {
  let time = 0; let sent = 0;
  const x = setup(t, { now: () => time, wakeRetryEnabled: true, wakeRetryDelays: [1], fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, [event()]);
    sent++; return response(503);
  } });
  await createInboxListener(x.options).tick(); time = 2;
  await createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...x.options, wakeRetryEnabled: false }).tick();
  assert.equal(sent, 1);
  assert.equal(x.state().pendingWakes[0].status, 'needs_review');
});

test('process-local duplicate history survives more than 500 messages, including uncertain acknowledgements', async (t) => {
  let batch = [event()]; let acks = 0;
  const x = setup(t, { outboxLimit: 2000, defaultWakeUrl: '', defaultAck: 'received', fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, batch);
    acks++; throw new Error('ack uncertain');
  } });
  const listener = createInboxListener(x.options);
  await listener.tick();
  batch = Array.from({ length: 501 }, (_, i) => event(`later-${i}`));
  await listener.tick();
  assert.equal(acks, 502);
  batch = [event()];
  await listener.tick();
  assert.equal(acks, 502);
  assert.equal(x.state().seen.length, 500);
});

test('uncertain acknowledgement tombstone survives restart and cache eviction', async (t) => {
  let batch = [event()]; let acks = 0;
  const x = setup(t, { outboxLimit: 2000, defaultWakeUrl: '', defaultAck: 'received', fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, batch);
    acks++;
    if (acks === 1) throw new Error('ack uncertain');
    return response();
  } });
  const listener = createInboxListener(x.options);
  await listener.tick();
  batch = Array.from({ length: 501 }, (_, i) => event(`later-${i}`));
  await listener.tick();
  assert.equal(x.state().uncertainAcks.length, 1);
  batch = [event()];
  await createInboxListener(x.options).tick();
  assert.equal(acks, 502);
});

test('the entire drained batch is committed before the first acknowledgement awaits', async (t) => {
  let acks = 0;
  const snapshots = [];
  const x = setup(t, { defaultAck: 'ok', fetch: async (url) => {
    if (url.endsWith('/messages')) return response(200, [event('a'), event('b'), event('c')]);
    if (url.endsWith('/send')) {
      acks++;
      snapshots.push({ pending: x.state().pendingWakes?.length || 0,
        rows: readFileSync(x.options.inboxPath, 'utf8').trim().split('\n').length });
    }
    return response();
  } });
  await createInboxListener(x.options).tick();
  assert.equal(acks, 3);
  assert.deepEqual(snapshots, Array(3).fill({ pending: 3, rows: 3 }));
});

test('a hanging bridge poll has a deadline and releases the next tick', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let polls = 0;
  const x = setup(t, { bridge: `http://127.0.0.1:${server.address().port}`, wakeTimeoutMs: 50, pollRetryDelays: [], fetch: async (...args) => {
    polls++; return fetch(...args);
  } });
  const listener = createInboxListener(x.options);
  await listener.tick();
  await listener.tick();
  assert.equal(polls, 2);
});
