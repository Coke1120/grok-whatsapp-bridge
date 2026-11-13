import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeAuthorizationHeaders } from './api_auth.js';
import { ACCOUNT_NAME_RE } from './access_scopes.js';

// Exit 2 means a definite refused connection, not an authentication failure,
// timeout, redirect, or unexpected HTTP response. Pairing must fail closed on 1.
export async function bridgeControlRequest({ action, account = '', env = process.env, fetchImpl = globalThis.fetch }) {
  const headers = bridgeAuthorizationHeaders(env.WHATSAPP_API_TOKEN);
  const port = String(env.WHATSAPP_BRIDGE_PORT || '37100');
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid bridge port.');
  if (!['health', 'pause', 'resume', 'logout'].includes(action)) throw new Error('Invalid bridge action.');
  if (account && !ACCOUNT_NAME_RE.test(account)) throw new Error('Invalid account name.');
  const route = (account ? '/accounts/' + encodeURIComponent(account) : '') + '/' + action;
  try {
    const response = await fetchImpl('http://127.0.0.1:' + port + route, {
      method: action === 'health' ? 'GET' : 'POST', headers,
      signal: AbortSignal.timeout(4000), redirect: 'error',
    });
    try { await response.body?.cancel(); } catch { /* Only status is relevant. */ }
    return response.ok ? 0 : 1;
  } catch (error) {
    return error?.cause?.code === 'ECONNREFUSED' ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await bridgeControlRequest({ action: process.argv[2], account: process.argv[3] || '' });
    if (process.exitCode === 1) console.error('Bridge request failed. Check authentication, configuration and bridge status.');
  } catch {
    console.error('Bridge request configuration is invalid. Check WHATSAPP_API_TOKEN, port and account.');
    process.exitCode = 1;
  }
}
