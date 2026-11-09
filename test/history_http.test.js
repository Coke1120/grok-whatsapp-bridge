import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createBridgeApp } from '../account_http.js';

const TOKEN = 'synthetic-history-test-token-000000000001';
const DM = '111@s.whatsapp.net';
const ENCODED_DM = encodeURIComponent(DM);
const CACHE = { nextCursor: null, source: 'local-cache', complete: false, truncated: false };

function account(name, overrides = {}) {
  const fake = {
    name, calls: [], queue: [{ messageId: `${name}-live` }], status: 'disconnected',
    healthSnapshot() { return { name, status: fake.status, session: `/synthetic/${name}`,
      queueLength: fake.queue.length, mode: 'bot', sendReadReceipts: false }; },
    drainMessages() { fake.calls.push(['drainMessages']); return fake.queue.splice(0); },
    listChats(options) {
      fake.calls.push(['listChats', options]);
      return { status: 200, body: { chats: [{ chatId: DM, name: `${name} cached chat` }], ...CACHE } };
    },
    chatMessages(chatId, options) {
      fake.calls.push(['chatMessages', chatId, options]);
      return { status: 200, body: { chatId, messages: [{ messageId: `${name}-cached` }], ...CACHE } };
    },
    async requestHistory(chatId, options) {
      fake.calls.push(['requestHistory', chatId, options]);
      return { status: 202, body: { chatId, requested: true, requestId: `${name}-provider-request`,
        count: options.count ?? 20, complete: false, source: 'provider-request', status: 'requested' } };
    },
    ...overrides,
  };
  return fake;
}

async function withServer(accounts, fn, overrides = {}) {
  const app = createBridgeApp({ accounts, defaultName: accounts[0].name,
    multi: accounts.length > 1, apiToken: TOKEN, scriptHash: 'synthetic-history-fixture', ...overrides });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(port, method, route, { headers = {}, body, authenticate = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: { ...(authenticate ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('all cached-history routes authenticate before account selection or dispatch', async () => {
  const fake = account('default');
  await withServer([fake], async (port) => {
    for (const prefix of ['', '/accounts/default', '/accounts/unknown']) {
      for (const [method, suffix] of [['GET', '/chats'], ['GET', `/chat/${ENCODED_DM}/messages`], ['POST', `/chat/${ENCODED_DM}/history`]]) {
        for (const headers of [{}, { Authorization: 'Bearer wrong-token' }]) {
          const result = await request(port, method, `${prefix}${suffix}`, { authenticate: false, headers,
            ...(method === 'POST' ? { body: { count: 20 } } : {}) });
          assert.equal(result.status, 401, `${method} ${prefix}${suffix}`);
          assert.equal(result.headers.get('www-authenticate'), 'Bearer');
        }
      }
    }
    assert.deepEqual(fake.calls, []);
    assert.equal(fake.queue.length, 1);
  });
});

test('cached GET routes stay available disconnected and never drain GET /messages', async () => {
  const fake = account('default');
  await withServer([fake], async (port) => {
    for (const prefix of ['', '/accounts/default']) {
      const chats = await request(port, 'GET', `${prefix}/chats?limit=3&groups=0`);
      assert.equal(chats.status, 200);
      assert.equal(chats.body.source, 'local-cache');
      assert.equal(chats.body.complete, false);
      assert.equal(chats.body.account, undefined);
      const messages = await request(port, 'GET', `${prefix}/chat/${ENCODED_DM}/messages?limit=2&cursor=synthetic.cursor`);
      assert.equal(messages.status, 200);
      assert.equal(messages.body.chatId, DM);
      assert.deepEqual(messages.body.messages, [{ messageId: 'default-cached' }]);
    }
    assert.equal(fake.queue.length, 1);
    assert.deepEqual(fake.calls, [
      ['listChats', { limit: '3', groups: '0' }],
      ['chatMessages', DM, { limit: '2', cursor: 'synthetic.cursor' }],
      ['listChats', { limit: '3', groups: '0' }],
      ['chatMessages', DM, { limit: '2', cursor: 'synthetic.cursor' }],
    ]);
    const queued = await request(port, 'GET', '/messages');
    assert.deepEqual(queued.body, [{ messageId: 'default-live' }]);
    assert.equal(fake.queue.length, 0);
    assert.deepEqual((await request(port, 'GET', `/chat/${ENCODED_DM}/messages`)).body.messages,
      [{ messageId: 'default-cached' }]);
  });
});

test('history routes honor the default, path, header, and query account selectors', async () => {
  const first = account('first');
  const second = account('second');
  await withServer([first, second], async (port) => {
    const cases = [
      { prefix: '', query: '', headers: {}, selected: first },
      { prefix: '/accounts/second', query: '', headers: {}, selected: second },
      { prefix: '', query: '', headers: { 'x-whatsapp-account': 'second' }, selected: second },
      { prefix: '', query: '?account=second', headers: {}, selected: second },
      { prefix: '/accounts/second', query: '?account=second', headers: { 'x-whatsapp-account': 'second' }, selected: second },
    ];
    for (const { prefix, query, headers, selected } of cases) {
      const chats = await request(port, 'GET', `${prefix}/chats${query}`, { headers });
      assert.equal(chats.status, 200);
      assert.equal(chats.body.account, selected.name);
      assert.equal(chats.body.chats[0].name, `${selected.name} cached chat`);
      const messages = await request(port, 'GET', `${prefix}/chat/${ENCODED_DM}/messages${query}`, { headers });
      assert.equal(messages.body.account, selected.name);
      assert.equal(messages.body.messages[0].messageId, `${selected.name}-cached`);
      const history = await request(port, 'POST', `${prefix}/chat/${ENCODED_DM}/history${query}`, { headers, body: { count: 7 } });
      assert.equal(history.status, 202);
      assert.equal(history.body.account, selected.name);
      assert.equal(history.body.requestId, `${selected.name}-provider-request`);
      assert.equal(history.body.complete, false);
      assert.deepEqual(selected.calls.at(-1), ['requestHistory', DM, { count: 7 }]);
    }
    assert.equal(first.queue.length, 1);
    assert.equal(second.queue.length, 1);
  });
});

test('conflicting selectors on every history route fail before account access', async () => {
  const first = account('first');
  const second = account('second');
  await withServer([first, second], async (port) => {
    for (const [method, suffix] of [['GET', '/chats'], ['GET', `/chat/${ENCODED_DM}/messages`], ['POST', `/chat/${ENCODED_DM}/history`]]) {
      const conflicts = [
        { route: `/accounts/first${suffix}?account=second`, headers: {} },
        { route: `/accounts/first${suffix}`, headers: { 'x-whatsapp-account': 'second' } },
        { route: `${suffix}?account=first`, headers: { 'x-whatsapp-account': 'second' } },
      ];
      for (const { route, headers } of conflicts) {
        const result = await request(port, method, route, { headers,
          ...(method === 'POST' ? { body: { count: 20 } } : {}) });
        assert.equal(result.status, 400, route);
        assert.equal(result.body.error, 'Conflicting WhatsApp account selectors');
      }
      const unknown = await request(port, method, `/accounts/missing${suffix}`, {
        ...(method === 'POST' ? { body: {} } : {}),
      });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error, 'Unknown WhatsApp account');
    }
    assert.deepEqual(first.calls, []);
    assert.deepEqual(second.calls, []);
  });
});

test('history POST forwards only the selected account request and reports acceptance rather than completion', async () => {
  const fake = account('default', { status: 'connected' });
  await withServer([fake], async (port) => {
    const result = await request(port, 'POST', `/chat/${ENCODED_DM}/history`, { body: { count: 50 } });
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, { chatId: DM, requested: true, requestId: 'default-provider-request',
      count: 50, complete: false, source: 'provider-request', status: 'requested' });
    assert.deepEqual(fake.calls, [['requestHistory', DM, { count: 50 }]]);
    assert.equal(fake.queue.length, 1);
  });
});

test('history route errors preserve runtime status, account context, and uncertainty', async () => {
  const first = account('first');
  const second = account('second', {
    listChats() { throw Object.assign(new Error('Invalid history cursor.'), { status: 400 }); },
    chatMessages() { return { status: 403, body: { error: 'Chat is outside this account read scope.' } }; },
    async requestHistory() { return { status: 503, body: { error: 'History request outcome is uncertain; do not retry automatically.' } }; },
  });
  await withServer([first, second], async (port) => {
    const list = await request(port, 'GET', '/accounts/second/chats?cursor=invalid');
    assert.equal(list.status, 400);
    assert.equal(list.body.account, 'second');
    const messages = await request(port, 'GET', `/accounts/second/chat/${ENCODED_DM}/messages`);
    assert.equal(messages.status, 403);
    assert.equal(messages.body.account, 'second');
    const history = await request(port, 'POST', `/accounts/second/chat/${ENCODED_DM}/history`, { body: {} });
    assert.equal(history.status, 503);
    assert.equal(history.body.account, 'second');
    assert.match(history.body.error, /uncertain/);
    assert.deepEqual(first.calls, []);
  });
});

test('history POST preserves disabled, missing-anchor, validation, and cooldown statuses', async () => {
  for (const status of [400, 403, 409, 429, 503]) {
    let calls = 0;
    const fake = account('default', {
      async requestHistory() { calls += 1; return { status, body: { error: `Synthetic ${status}` } }; },
    });
    await withServer([fake], async (port) => {
      const result = await request(port, 'POST', `/chat/${ENCODED_DM}/history`, { body: {} });
      assert.equal(result.status, status);
      assert.equal(result.body.error, `Synthetic ${status}`);
      assert.equal(calls, 1, 'the HTTP layer must not retry a history request');
    });
  }
});
