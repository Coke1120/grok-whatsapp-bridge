import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInboxListener } from '../listener.mjs';
import { parseAccessScopes, scopeForAccount } from '../access_scopes.js';

const OWNER = '15550000001@lid';
const OTHER = '15550000002@s.whatsapp.net';
const scope = (fields) => scopeForAccount(parseAccessScopes(JSON.stringify({ default: fields })), 'default');
const event = (chatId, extra = {}) => ({ chatId, senderId: chatId, body: 'synthetic fixture',
  messageId: chatId, scopeVersion: 1, eventType: 'message', fromOwner: false, ...extra });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  async text() { return JSON.stringify(body); }, async json() { return body; } });
function paths(dir) { return { inboxPath: path.join(dir, 'inbox.jsonl'), statePath: path.join(dir, 'state.json'), unreadFlagPath: path.join(dir, 'flag') }; }
function rows(file) { return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }

test('passive read caching is independent of automatic wake, acknowledgement and unread flags', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scopes-'));
  const calls = [];
  const files = paths(dir);
  let queue = [event(OTHER)];
  try {
    const listener = createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...files, accounts: [{ name: 'default', allowedUsers: '*',
      accessScope: scope({ readAllDms: true, triggerChats: [OWNER], sendChats: [OWNER] }) }],
      defaultAck: 'fixture ack', defaultWakeUrl: 'https://receiver.invalid/hook', log() {}, warn() {},
      fetch: async (url, options) => { calls.push({ url, options }); if (url.endsWith('/messages')) { const batch = queue; queue = []; return response(batch); } return response({}); },
    });
    await listener.tick();
    assert.equal(rows(files.inboxPath)[0].readAllowed, true);
    assert.equal(rows(files.inboxPath)[0].allowed, false);
    assert.equal(calls.length, 1);
    assert.equal(existsSync(files.unreadFlagPath), false);
    queue = [event(OWNER)];
    await listener.tick();
    const wakes = calls.filter((c) => c.url === 'https://receiver.invalid/hook');
    const acks = calls.filter((c) => c.url.endsWith('/send'));
    assert.equal(wakes.length, 1);
    assert.equal(JSON.parse(wakes[0].options.body).chatId, OWNER);
    assert.equal(acks.length, 1);
    assert.equal(JSON.parse(acks[0].options.body).chatId, OWNER);
    assert.equal(existsSync(files.unreadFlagPath), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scoped listener never retains denied bodies or accepts cross-account events', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scope-drop-'));
  const files = paths(dir);
  const logs = [];
  try {
    const listener = createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...files, accounts: [{ name: 'default', allowedUsers: '*', accessScope: scope({ readChats: [OWNER] }) }],
      defaultWakeUrl: 'https://receiver.invalid/hook', log: (s) => logs.push(s), warn() {},
      fetch: async () => response([event(OTHER, { body: 'must not persist' }), event(OWNER, { account: 'another', body: 'wrong account' })]),
    });
    await listener.tick();
    assert.deepEqual(rows(files.inboxPath), []);
    assert.equal(logs.some((s) => s.includes('must not persist') || s.includes('wrong account')), false);
    assert.equal(readFileSync(files.statePath, 'utf8').includes('must not persist'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('poll aggregates, owner messages and old unmarked events are read-only, never automatic triggers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scope-origin-'));
  const files = paths(dir);
  const writes = [];
  try {
    const listener = createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...files, accounts: [{ name: 'default', accessScope: scope({ readAllDms: true, triggerChats: [OWNER], sendChats: [OWNER] }) }],
      defaultAck: 'no', defaultWakeUrl: 'https://receiver.invalid/hook', log() {}, warn() {},
      fetch: async (url, options) => { if (options?.method === 'POST') writes.push(url); return response(url.endsWith('/messages') ? [
        event(OWNER, { messageId: 'poll', eventType: 'poll_update' }),
        event(OWNER, { messageId: 'self', fromOwner: true }),
        event(OWNER, { messageId: 'old', scopeVersion: undefined }),
      ] : {}); },
    });
    await listener.tick();
    assert.equal(rows(files.inboxPath).length, 3);
    assert(rows(files.inboxPath).every((r) => r.allowed === false && r.readAllowed === true));
    assert.deepEqual(writes, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pending wake is blocked when current trigger or read scope is revoked', async () => {
  for (const tightened of [{ readAllDms: true, triggerChats: [] }, { triggerChats: [OWNER] }]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scope-revoke-'));
    const files = paths(dir);
    let now = 100;
    let polls = 0;
    let wakes = 0;
    const account = { name: 'default', accessScope: scope({ readAllDms: true, triggerChats: [OWNER] }) };
    try {
      const listener = createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...files, accounts: [account], defaultWakeUrl: 'https://receiver.invalid/hook',
        wakeRetryEnabled: true, wakeRetryDelays: [1], now: () => now, log() {}, warn() {},
        fetch: async (url) => {
          if (url.endsWith('/messages')) return response(polls++ === 0 ? [event(OWNER)] : []);
          wakes += 1; return response({}, 503);
        },
      });
      await listener.tick();
      assert.equal(wakes, 1);
      account.accessScope = scope(tightened);
      now += 5;
      await listener.tick();
      assert.equal(wakes, 1);
      assert.equal(JSON.parse(readFileSync(files.statePath, 'utf8')).pendingWakes[0].status, 'blocked');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('readable trigger without a send grant wakes but never acknowledges', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scope-no-send-'));
  const calls = [];
  try {
    const listener = createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...paths(dir), accounts: [{ name: 'default', accessScope: scope({ readChats: [OWNER], triggerChats: [OWNER] }) }],
      defaultAck: 'must not send', defaultWakeUrl: 'https://receiver.invalid/hook', log() {}, warn() {},
      fetch: async (url, options) => { calls.push({ url, options }); return response(url.endsWith('/messages') ? [event(OWNER)] : {}); },
    });
    await listener.tick();
    assert.equal(calls.filter((c) => c.url === 'https://receiver.invalid/hook').length, 1);
    assert.equal(calls.some((c) => c.url.endsWith('/send')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('named listener accounts keep equal chat IDs, trigger permissions and acknowledgements separate', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scope-accounts-'));
  const calls = [];
  const policy = parseAccessScopes(JSON.stringify({
    primary: { readAllDms: true, triggerChats: [OWNER], sendChats: [OWNER] }, secondary: { readAllDms: true },
  }));
  const accounts = ['primary', 'secondary'].map((name) => ({ name, accessScope: scopeForAccount(policy, name) }));
  try {
    const listener = createInboxListener({ apiToken: 'fixture-bridge-token-not-a-secret-0001', ...paths(dir), accounts, multi: true,
      defaultAck: 'fixture ack', defaultWakeUrl: 'https://receiver.invalid/hook', log() {}, warn() {},
      fetch: async (url, options) => {
        calls.push({ url, options });
        return response(url.endsWith('/messages') ? [event(OWNER, { messageId: 'same-id' })] : {});
      },
    });
    await listener.tick();
    const recorded = rows(paths(dir).inboxPath);
    assert.deepEqual(recorded.map((r) => r.account), ['primary', 'secondary']);
    assert.deepEqual(recorded.map((r) => r.allowed), [true, false]);
    assert.notEqual(recorded[0].deliveryId, recorded[1].deliveryId);
    const wakes = calls.filter((c) => c.url === 'https://receiver.invalid/hook');
    assert.equal(wakes.length, 1);
    assert.equal(JSON.parse(wakes[0].options.body).account, 'primary');
    assert.equal(calls.filter((c) => c.url.endsWith('/send')).length, 1);
    assert(calls.some((c) => c.url.endsWith('/accounts/primary/send')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a persisted wake with a mismatched payload account is blocked after listener restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-scope-persisted-account-'));
  const files = paths(dir);
  const policy = parseAccessScopes(JSON.stringify({ primary: { readAllDms: true, triggerChats: [OWNER] } }));
  let wakes = 0, polls = 0, now = 100;
  const opts = { apiToken: 'fixture-bridge-token-not-a-secret-0001', ...files, multi: true, accounts: [{ name: 'primary', accessScope: scopeForAccount(policy, 'primary') }],
    defaultWakeUrl: 'https://receiver.invalid/hook', wakeRetryEnabled: true, wakeRetryDelays: [1],
    now: () => now, log() {}, warn() {},
    fetch: async (url) => {
      if (url.endsWith('/messages')) return response(polls++ === 0 ? [event(OWNER)] : []);
      wakes += 1; return response({}, 503);
    },
  };
  try {
    await createInboxListener(opts).tick();
    assert.equal(wakes, 1);
    const stored = JSON.parse(readFileSync(files.statePath, 'utf8'));
    stored.pendingWakes[0].payload.account = 'secondary';
    writeFileSync(files.statePath, JSON.stringify(stored), { mode: 0o600 });
    now += 5;
    await createInboxListener(opts).tick();
    assert.equal(wakes, 1);
    assert.equal(JSON.parse(readFileSync(files.statePath, 'utf8')).pendingWakes[0].status, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
