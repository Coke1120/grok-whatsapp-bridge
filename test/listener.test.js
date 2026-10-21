import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInboxListener } from '../listener.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('single-account listener keeps the historical poll, inbox row, and webhook', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-'));
  const calls = [];
  try {
    const listener = createInboxListener({
      bridge: 'http://127.0.0.1:3100',
      multi: false,
      accounts: [{ name: 'default', allowedUsers: '+111', programmaticAck: null, wakeWebhookUrl: null, wakeWebhookAuth: null }],
      defaultAck: '',
      defaultWakeUrl: 'https://example.invalid/wake',
      defaultWakeAuth: 'secret-token',
      inboxPath: path.join(dir, 'inbox.jsonl'),
      statePath: path.join(dir, 'listener-state.json'),
      unreadFlagPath: path.join(dir, 'unread.flag'),
      log() {},
      fetch: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/messages')) {
          return jsonResponse([{
            messageId: 'm1',
            chatId: '111@s.whatsapp.net',
            senderId: '111@s.whatsapp.net',
            senderName: 'Ada',
            body: 'hello',
            hasMedia: false,
          }]);
        }
        return jsonResponse({ success: true });
      },
    });

    const lines = [];
    const started = createInboxListener({
      bridge: 'http://127.0.0.1:3100',
      multi: false,
      accounts: [{ name: 'default', allowedUsers: '111', programmaticAck: null, wakeWebhookUrl: null, wakeWebhookAuth: null }],
      defaultAck: '',
      defaultWakeUrl: 'https://example.invalid/wake',
      defaultWakeAuth: '',
      inboxPath: path.join(dir, 'inbox-banner.jsonl'),
      statePath: path.join(dir, 'state-banner.json'),
      unreadFlagPath: path.join(dir, 'unread-banner.flag'),
      pollMs: 60_000,
      log: (line) => lines.push(line),
      fetch: async () => jsonResponse([]),
    });
    await started.start();
    await started.stop();
    assert.equal(lines[0], '[listener] bridge=http://127.0.0.1:3100 allow=111 ack=off wake=on');

    await listener.tick();
    await listener.tick();
    const wake = calls.filter((call) => call.url === 'https://example.invalid/wake');
    assert.equal(wake.length, 1);
    assert.equal(wake[0].options.headers.Authorization, 'Bearer secret-token');
    const payload = JSON.parse(wake[0].options.body);
    assert.deepEqual(Object.keys(payload), ['source', 'chatId', 'senderId', 'senderName', 'body', 'hasMedia', 'ts']);
    assert.equal(payload.source, 'whatsapp-bridge-listener');
    assert.equal(payload.body, 'hello');
    assert.equal(calls.some((call) => call.url.endsWith('/accounts/')), false);
    assert.equal(calls.filter((call) => String(call.url).endsWith('/messages')).length, 2);

    const rows = readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]), ['ts', 'allowed', 'chatId', 'senderId', 'senderName', 'body', 'hasMedia']);
    assert.equal(rows[0].allowed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-account listener polls, wakes, and acks each account separately', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-multi-'));
  const calls = [];
  try {
    const listener = createInboxListener({
      bridge: 'http://127.0.0.1:3100',
      multi: true,
      accounts: [
        {
          name: 'ops',
          allowedUsers: '111',
          programmaticAck: 'ack-ops',
          wakeWebhookUrl: 'https://example.invalid/ops',
          wakeWebhookAuth: 'Bearer ops-token',
        },
        {
          name: 'sales',
          allowedUsers: '222',
          programmaticAck: '',
          wakeWebhookUrl: '',
          wakeWebhookAuth: null,
        },
      ],
      defaultAck: 'should-not-send',
      defaultWakeUrl: 'https://example.invalid/default',
      defaultWakeAuth: 'Bearer default-token',
      inboxPath: path.join(dir, 'inbox.jsonl'),
      statePath: path.join(dir, 'listener-state.json'),
      unreadFlagPath: path.join(dir, 'unread.flag'),
      log() {},
      fetch: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/ops/messages')) {
          return jsonResponse([{
            messageId: 'same',
            chatId: '111@s.whatsapp.net',
            senderId: '111@s.whatsapp.net',
            senderName: 'Ops',
            body: 'from-ops',
            hasMedia: false,
          }]);
        }
        if (url.endsWith('/sales/messages')) {
          return jsonResponse([{
            messageId: 'same',
            chatId: '222@s.whatsapp.net',
            senderId: '222@s.whatsapp.net',
            senderName: 'Sales',
            body: 'from-sales',
            hasMedia: true,
          }]);
        }
        return jsonResponse({ success: true });
      },
    });
    await listener.tick();

    const polled = calls.filter((call) => call.options === undefined || call.options.method === undefined).map((call) => call.url);
    assert.deepEqual(polled, [
      'http://127.0.0.1:3100/accounts/ops/messages',
      'http://127.0.0.1:3100/accounts/sales/messages',
    ]);
    const wakes = calls.filter((call) => String(call.url).includes('example.invalid'));
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].url, 'https://example.invalid/ops');
    assert.equal(wakes[0].options.headers.Authorization, 'Bearer ops-token');
    assert.equal(JSON.parse(wakes[0].options.body).account, 'ops');

    const acks = calls.filter((call) => call.options?.method === 'POST' && String(call.url).endsWith('/send'));
    assert.equal(acks.length, 1);
    assert.equal(acks[0].url, 'http://127.0.0.1:3100/accounts/ops/send');
    assert.deepEqual(JSON.parse(acks[0].options.body), { chatId: '111@s.whatsapp.net', message: 'ack-ops' });

    const rows = readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.account), ['ops', 'sales']);
    assert.equal(rows[1].allowed, true);
    const state = JSON.parse(readFileSync(path.join(dir, 'listener-state.json'), 'utf8'));
    assert.ok(state.seen.includes('ops:same'));
    assert.ok(state.seen.includes('sales:same'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-allowlisted inbound is logged and does not wake', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-listener-drop-'));
  const calls = [];
  try {
    const listener = createInboxListener({
      bridge: 'http://bridge',
      multi: false,
      accounts: [{ name: 'default', allowedUsers: '111', programmaticAck: 'ack', wakeWebhookUrl: null, wakeWebhookAuth: null }],
      defaultAck: 'ack',
      defaultWakeUrl: 'https://example.invalid/wake',
      defaultWakeAuth: '',
      inboxPath: path.join(dir, 'inbox.jsonl'),
      statePath: path.join(dir, 'state.json'),
      unreadFlagPath: path.join(dir, 'unread.flag'),
      log() {},
      fetch: async (url, options) => {
        calls.push({ url, options });
        if (String(url).endsWith('/messages')) {
          return jsonResponse([{
            messageId: 'm2',
            chatId: '999@s.whatsapp.net',
            senderId: '999@s.whatsapp.net',
            senderName: 'Nope',
            body: 'spam',
            hasMedia: false,
          }]);
        }
        return jsonResponse({ success: true });
      },
    });
    await listener.tick();
    const row = JSON.parse(readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8'));
    assert.equal(row.allowed, false);
    assert.equal(calls.some((call) => call.url === 'https://example.invalid/wake'), false);
    assert.equal(calls.some((call) => String(call.url).endsWith('/send')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
