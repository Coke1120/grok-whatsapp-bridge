import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeControlRequest } from '../bridge_http_client.mjs';

const TOKEN = 'fixture-bridge-token-not-a-secret-0001';
const env = { WHATSAPP_API_TOKEN: TOKEN };

test('health and administrative helpers authenticate without redirecting or exposing credentials', async () => {
  for (const action of ['health', 'pause', 'resume', 'logout']) {
    let call;
    const result = await bridgeControlRequest({ action, account: action === 'health' ? '' : 'primary', env,
      fetchImpl: async (url, options) => { call = { url, options }; return { ok: true }; },
    });
    assert.equal(result, 0);
    assert.equal(call.url, 'http://127.0.0.1:37100' + (action === 'health' ? '/health' : '/accounts/primary/' + action));
    assert.equal(call.options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.method, action === 'health' ? 'GET' : 'POST');
    assert.ok(call.options.signal);
  }
});

test('only a definite refused connection permits offline pairing', async () => {
  for (const status of [301, 401, 403, 404, 500, 503]) {
    assert.equal(await bridgeControlRequest({ action: 'health', env,
      fetchImpl: async () => ({ ok: false, status }),
    }), 1);
  }
  for (const code of ['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', undefined]) {
    assert.equal(await bridgeControlRequest({ action: 'health', env,
      fetchImpl: async () => { throw Object.assign(new Error('private detail'), { cause: { code } }); },
    }), 1);
  }
  assert.equal(await bridgeControlRequest({ action: 'health', env,
    fetchImpl: async () => { throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); },
  }), 2);
});

test('control helper rejects missing or malformed configuration before requests', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('Must not fetch'); };
  for (const token of [undefined, '', 'short', TOKEN + '\n']) {
    await assert.rejects(bridgeControlRequest({ action: 'health', env: { WHATSAPP_API_TOKEN: token }, fetchImpl }), /WHATSAPP_API_TOKEN/);
  }
  for (const input of [{ action: 'send' }, { action: 'pause', account: '../wrong' },
    { action: 'health', env: { ...env, WHATSAPP_BRIDGE_PORT: '1/evil' } }]) {
    await assert.rejects(bridgeControlRequest({ env, fetchImpl, ...input }));
  }
  assert.equal(calls, 0);
});
