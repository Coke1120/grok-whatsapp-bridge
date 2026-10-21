import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createBridgeApp, parseTrustedHosts } from '../account_http.js';

function fakeAccount(name, overrides = {}) {
  const calls = [];
  const account = {
    name,
    status: 'connected',
    queue: [],
    session: `/tmp/${name}`,
    mode: 'bot',
    sendReadReceipts: false,
    linkedUser: '',
    calls,
    healthSnapshot() {
      return {
        name,
        status: account.status,
        session: account.session,
        queueLength: account.queue.length,
        mode: account.mode,
        sendReadReceipts: account.sendReadReceipts,
        linkedUser: account.linkedUser,
      };
    },
    drainMessages() {
      return account.queue.splice(0);
    },
    async send(body) {
      calls.push(['send', body]);
      return { status: 200, body: { success: true, messageId: `${name}-id`, messageIds: [`${name}-id`] } };
    },
    async edit(body) {
      calls.push(['edit', body]);
      return { status: 200, body: { success: true, messageIds: [] } };
    },
    async sendMedia() {
      return { status: 200, body: { success: true, messageId: 'media' } };
    },
    async sendPoll() {
      return { status: 200, body: { success: true, messageId: 'poll' } };
    },
    async sendLocation() {
      return { status: 200, body: { success: true, messageId: 'loc' } };
    },
    async typing() {
      return { status: 200, body: { success: true } };
    },
    async markRead() {
      return { status: 200, body: { success: true, marked: false } };
    },
    async chatInfo(id) {
      calls.push(['chat', id]);
      return { status: 200, body: { name: id, isGroup: false, participants: [] } };
    },
    async logout() {
      account.status = 'logged_out';
      return { status: 200, body: { success: true, account: name, status: 'logged_out' } };
    },
    async pause() {
      account.status = 'paused';
      return { status: 200, body: { success: true, account: name, status: 'paused' } };
    },
    async resume() {
      account.status = 'disconnected';
      return { status: 200, body: { success: true, account: name, status: 'disconnected' } };
    },
    ...overrides,
  };
  return account;
}

async function withApp(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function req(port, method, urlPath, { headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

test('single-account /health matches the legacy shape', async () => {
  const app = createBridgeApp({
    accounts: [fakeAccount('default', { session: '/data/session', sendReadReceipts: true })],
    defaultName: 'default',
    multi: false,
    scriptHash: 'abc123',
    uptime: () => 12.5,
  });
  await withApp(app, async (port) => {
    const { status, json } = await req(port, 'GET', '/health');
    assert.equal(status, 200);
    assert.deepEqual(json, {
      status: 'connected',
      queueLength: 0,
      uptime: 12.5,
      scriptHash: 'abc123',
      sendReadReceipts: true,
      session: '/data/session',
      capabilities: { outboundMentions: true },
    });
  });
});

test('multi /health lists every account and keeps legacy fields for the default', async () => {
  const ops = fakeAccount('ops', { session: '/data/session', linkedUser: '…1111@s.whatsapp.net' });
  const sales = fakeAccount('sales', { session: '/data/sales', status: 'disconnected' });
  const app = createBridgeApp({
    accounts: [ops, sales],
    defaultName: 'ops',
    multi: true,
    scriptHash: 'abc123',
    uptime: () => 3,
  });
  await withApp(app, async (port) => {
    const all = await req(port, 'GET', '/health');
    assert.equal(all.status, 200);
    assert.equal(all.json.status, 'connected');
    assert.equal(all.json.session, '/data/session');
    assert.equal(all.json.multi, true);
    assert.equal(all.json.defaultAccount, 'ops');
    assert.equal(all.json.allConnected, false);
    assert.deepEqual(all.json.accounts.map((account) => account.name), ['ops', 'sales']);
    assert.equal(all.json.accounts[1].status, 'disconnected');
    assert.equal(all.json.accounts[0].linkedUser, '…1111@s.whatsapp.net');
    assert.equal(all.json.queueLength, 0);

    const one = await req(port, 'GET', '/health?account=sales');
    assert.equal(one.json.status, 'disconnected');
    assert.equal(one.json.session, '/data/sales');
    assert.equal(one.json.account, 'sales');
    assert.equal(one.json.mode, 'bot');
    assert.equal(one.json.multi, undefined);

    const byHeader = await req(port, 'GET', '/accounts/ops/health', {
      headers: { 'x-whatsapp-account': 'ops' },
    });
    assert.equal(byHeader.json.account, 'ops');
    assert.equal(byHeader.json.linkedUser, '…1111@s.whatsapp.net');
  });
});

test('send, messages, and chat follow path, header, then query and otherwise use the default', async () => {
  const ops = fakeAccount('ops');
  const sales = fakeAccount('sales');
  ops.queue.push({ messageId: 'ops-1', body: 'a' });
  sales.queue.push({ messageId: 'sales-1', body: 'b' });
  const app = createBridgeApp({
    accounts: [ops, sales],
    defaultName: 'ops',
    multi: true,
    scriptHash: 'hash',
    uptime: () => 1,
  });
  await withApp(app, async (port) => {
    const unscoped = await req(port, 'POST', '/send', { body: { chatId: '1@s.whatsapp.net', message: 'hi' } });
    assert.equal(unscoped.json.messageId, 'ops-id');
    assert.equal(unscoped.json.account, 'ops');
    assert.equal(ops.calls[0][0], 'send');

    const byPath = await req(port, 'POST', '/accounts/sales/send', { body: { chatId: '1@s.whatsapp.net', message: 'hi' } });
    assert.equal(byPath.json.account, 'sales');

    const byHeader = await req(port, 'POST', '/send', {
      headers: { 'x-whatsapp-account': 'sales' },
      body: { chatId: '1@s.whatsapp.net', message: 'header' },
    });
    assert.equal(byHeader.json.account, 'sales');

    const byQuery = await req(port, 'POST', '/edit?account=sales', {
      body: { chatId: '1@s.whatsapp.net', messageId: 'm', message: 'edited' },
    });
    assert.equal(byQuery.json.account, 'sales');
    assert.equal(sales.calls.some((call) => call[0] === 'edit'), true);

    const opsMessages = await req(port, 'GET', '/messages');
    assert.deepEqual(opsMessages.json, [{ messageId: 'ops-1', body: 'a' }]);
    const salesMessages = await req(port, 'GET', '/accounts/sales/messages');
    assert.deepEqual(salesMessages.json, [{ messageId: 'sales-1', body: 'b' }]);

    const chat = await req(port, 'GET', '/accounts/sales/chat/123%40s.whatsapp.net');
    assert.equal(chat.json.name, '123@s.whatsapp.net');
    assert.equal(chat.json.account, 'sales');
  });
});

test('disagreeing selectors are rejected and unknown accounts list the known names', async () => {
  const app = createBridgeApp({
    accounts: [fakeAccount('ops'), fakeAccount('sales')],
    defaultName: 'ops',
    multi: true,
    scriptHash: 'hash',
    uptime: () => 1,
  });
  await withApp(app, async (port) => {
    const conflict = await req(port, 'POST', '/accounts/ops/send?account=sales', {
      body: { chatId: '1@s.whatsapp.net', message: 'x' },
    });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.json.error, 'Conflicting WhatsApp account selectors');
    assert.deepEqual(conflict.json.selectors, { path: 'ops', query: 'sales' });

    const missing = await req(port, 'GET', '/health', { headers: { 'x-whatsapp-account': 'nope' } });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, {
      error: 'Unknown WhatsApp account',
      account: 'nope',
      accounts: ['ops', 'sales'],
    });
  });
});

test('disconnected sends keep the historical error strings', async () => {
  const account = fakeAccount('default', { status: 'disconnected' });
  const app = createBridgeApp({
    accounts: [account],
    defaultName: 'default',
    multi: false,
    scriptHash: 'hash',
    uptime: () => 1,
  });
  await withApp(app, async (port) => {
    const send = await req(port, 'POST', '/send', { body: { chatId: '1@s.whatsapp.net', message: 'hi' } });
    assert.equal(send.status, 503);
    assert.deepEqual(send.json, { error: 'Not connected to WhatsApp' });
    assert.equal(account.calls.length, 0);

    const typing = await req(port, 'POST', '/typing', { body: { chatId: '1@s.whatsapp.net' } });
    assert.deepEqual(typing.json, { error: 'Not connected' });

    const read = await req(port, 'POST', '/read', { body: { key: { id: 'a' } } });
    assert.deepEqual(read.json, { error: 'Not connected' });

    const messages = await req(port, 'GET', '/messages');
    assert.deepEqual(messages.json, []);

    const scoped = await req(port, 'GET', '/accounts/default/health');
    assert.equal(scoped.json.status, 'disconnected');
    assert.equal(scoped.json.account, undefined);
    assert.equal(Object.hasOwn(scoped.json, 'multi'), false);
  });
});

test('invalid Host header is rejected', async () => {
  const app = createBridgeApp({
    accounts: [fakeAccount('default')],
    defaultName: 'default',
    multi: false,
    scriptHash: 'hash',
    uptime: () => 1,
  });
  await withApp(app, async (port) => {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: { host: 'evil.example' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error, 'Invalid Host header. Bridge accepts loopback hosts only.');
  });
});

test('Compose service name is opt-in and other hosts stay rejected', async () => {
  assert.deepEqual(parseTrustedHosts(' bridge ,'), ['bridge']);
  assert.deepEqual(parseTrustedHosts(''), []);
  assert.deepEqual(
    parseTrustedHosts('bridge,leohofamily.tail48056.ts.net'),
    ['bridge', 'leohofamily.tail48056.ts.net'],
  );
  assert.throws(() => parseTrustedHosts('http://bridge'), /WHATSAPP_TRUSTED_HOSTS/);

  const plain = createBridgeApp({
    accounts: [fakeAccount('default')],
    defaultName: 'default',
    multi: false,
    scriptHash: 'hash',
    uptime: () => 1,
  });
  const trusted = createBridgeApp({
    accounts: [fakeAccount('default')],
    defaultName: 'default',
    multi: false,
    scriptHash: 'hash',
    trustedHosts: parseTrustedHosts('bridge'),
    uptime: () => 1,
  });

  function ask(app, host) {
    return withApp(app, (port) => new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: { host },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
      });
      request.on('error', reject);
      request.end();
    }));
  }

  const blocked = await ask(plain, 'bridge:37100');
  assert.equal(blocked.status, 400);

  const allowed = await ask(trusted, 'bridge:37100');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.status, 'connected');

  const evil = await ask(trusted, 'evil.example');
  assert.equal(evil.status, 400);
});

test('logout and pause target the selected account', async () => {
  const sales = fakeAccount('sales');
  const app = createBridgeApp({
    accounts: [fakeAccount('ops'), sales],
    defaultName: 'ops',
    multi: true,
    scriptHash: 'hash',
    uptime: () => 1,
  });
  await withApp(app, async (port) => {
    const paused = await req(port, 'POST', '/accounts/sales/pause');
    assert.equal(paused.status, 200);
    assert.equal(paused.json.status, 'paused');
    assert.equal(sales.status, 'paused');
    const loggedOut = await req(port, 'POST', '/logout?account=sales');
    assert.equal(loggedOut.json.status, 'logged_out');
    assert.equal(sales.status, 'logged_out');
  });
});
