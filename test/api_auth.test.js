import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { bridgeAuthorizationHeaders, createApiAuthenticator, requireApiToken } from '../api_auth.js';
import { createBridgeApp } from '../account_http.js';

const TOKEN = 'synthetic-fixture-token-00000000000001';
const WRONG = 'synthetic-fixture-token-00000000000002';
const AUTH = bridgeAuthorizationHeaders(TOKEN);

test('API tokens have no empty/short/whitespace defaults and never appear in errors', () => {
  for (const token of [undefined, '', 'short', 'a'.repeat(257), TOKEN + '\n', ' ' + TOKEN, TOKEN + '+', {}, null]) {
    assert.throws(() => requireApiToken(token), (error) => error.message.includes('WHATSAPP_API_TOKEN') && !error.message.includes(TOKEN));
  }
  assert.equal(requireApiToken(TOKEN), TOKEN);
  assert.deepEqual(AUTH, { Authorization: `Bearer ${TOKEN}` });
  assert.throws(() => createApiAuthenticator(''), /WHATSAPP_API_TOKEN/);
  assert.throws(() => createBridgeApp({ accounts: [], defaultName: 'default' }), /WHATSAPP_API_TOKEN/);
});

test('Bearer matcher rejects duplicate credentials and accepts case-insensitive scheme only', () => {
  const authenticate = createApiAuthenticator(TOKEN);
  const req = (header, rawHeaders = ['Authorization', header]) => ({ headers: { authorization: header }, rawHeaders });
  assert.equal(authenticate(req(`bearer ${TOKEN}`)), true);
  for (const header of ['', `Basic ${TOKEN}`, `Bearer ${WRONG}`, `Bearer ${TOKEN}, Bearer ${TOKEN}`, `Bearer ${TOKEN} `]) {
    assert.equal(authenticate(req(header)), false);
  }
  assert.equal(authenticate(req(`Bearer ${TOKEN}`, ['Authorization', `Bearer ${TOKEN}`, 'authorization', `Bearer ${WRONG}`])), false);
});

test('every REST surface authenticates before body parsing, queue drain and account effects', async () => {
  let calls = 0;
  const effect = () => { calls++; return { status: 200, body: { success: true } }; };
  const account = { name: 'default', healthSnapshot() { calls++; return { status: 'connected', queueLength: 1 }; },
    drainMessages() { calls++; return [{ body: 'synthetic-only' }]; }, send: effect, edit: effect,
    sendMedia: effect, sendPoll: effect, sendLocation: effect, typing: effect, markRead: effect,
    chatInfo: effect, logout: effect, pause: effect, resume: effect };
  const server = http.createServer(createBridgeApp({ apiToken: TOKEN, accounts: [account], defaultName: 'default', multi: false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const paths = ['/health', '/messages', '/chat/15550000001@lid', '/send', '/edit', '/send-media', '/send-poll', '/send-location', '/typing', '/read', '/logout', '/pause', '/resume'];
    for (const prefix of ['', '/accounts/default']) {
      for (const path of paths) {
        const method = ['/health', '/messages'].includes(path) || path.startsWith('/chat/') ? 'GET' : 'POST';
        for (const headers of [{}, { Authorization: `Bearer ${WRONG}` }]) {
          const result = await fetch(base + prefix + path + '?token=' + TOKEN, { method, headers });
          assert.equal(result.status, 401, prefix + path);
          assert.equal(result.headers.get('www-authenticate'), 'Bearer');
          assert.deepEqual(await result.json(), { error: 'Unauthorized' });
        }
      }
    }
    const duplicate = await new Promise((resolve, reject) => {
      const request = http.request(base + '/messages', { headers: { Authorization: [`Bearer ${TOKEN}`, `Bearer ${WRONG}`] } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(duplicate, 401);
    const malformed = await fetch(base + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(malformed.status, 401);
    assert.equal(calls, 0);
    const accepted = await fetch(base + '/messages', { headers: AUTH });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json())[0].body, 'synthetic-only');
    assert.equal(calls, 1);
    // A trusted Host value or account selector cannot replace a credential.
    assert.equal((await fetch(base + '/health', { headers: { 'X-WhatsApp-Account': 'default' } })).status, 401);
    assert.equal(calls, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
