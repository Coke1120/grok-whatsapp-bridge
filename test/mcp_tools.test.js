import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWhatsAppTools, readRecentInbox, validateBridgeUrl } from '../mcp/tools.mjs';

const JID = '85212345678@s.whatsapp.net';
const BASE_ENV = {
  WHATSAPP_API_TOKEN: 'fixture-bridge-token-not-a-secret-0001',
  WHATSAPP_BRIDGE_URL: 'http://127.0.0.1:37100',
  WHATSAPP_MCP_ALLOWED_CHATS: JID,
  WHATSAPP_MCP_SEND_ENABLED: '1',
};

test('local inbox tools work without a token but every HTTP tool requires valid authentication', async () => {
  for (const token of [undefined, '', 'short', 'private-token-with-whitespace ']) {
    let calls = 0;
    const tools = createWhatsAppTools({
      env: { ...BASE_ENV, WHATSAPP_API_TOKEN: token,
        WHATSAPP_SCOPES: JSON.stringify({ default: { readChats: [JID], sendChats: [JID] } }) },
      inboxReader: async () => [], fetchImpl: async () => { calls++; throw new Error('Must not fetch'); },
    });
    assert.deepEqual(JSON.parse((await tools.invoke('whatsapp_recent_messages')).content[0].text), []);
    for (const [tool, args] of [['whatsapp_status', {}], ['whatsapp_chat_info', { chatId: JID }],
      ['whatsapp_send_message', { chatId: JID, message: 'Fixture' }]]) {
      await assert.rejects(tools.invoke(tool, args), (error) => {
        assert.match(error.message, /WHATSAPP_API_TOKEN/);
        if (token) assert.ok(!error.message.includes(token));
        return true;
      });
    }
    assert.equal(calls, 0);
  }
});

test('bridge URL rejects remote, credentials and arbitrary URL paths', () => {
  assert.equal(validateBridgeUrl('http://127.0.0.1:37100'), 'http://127.0.0.1:37100');
  assert.throws(() => validateBridgeUrl('http://example.com:37100'));
  assert.throws(() => validateBridgeUrl('http://127.0.0.1:37100/private'));
  assert.throws(() => validateBridgeUrl('http://u:pass@127.0.0.1:37100'));
  assert.throws(() => validateBridgeUrl('https://evil.net', true));
  assert.equal(validateBridgeUrl('https://mini.example.ts.net/', true), 'https://mini.example.ts.net');
});

test('MCP sends only with explicit allowlist and send switch', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ success: true, messageId: 'abc' }), { status: 200 });
  };
  const tools = createWhatsAppTools({ env: { ...BASE_ENV, WHATSAPP_SCOPES: JSON.stringify({ default: { sendChats: [JID] } }) }, fetchImpl });
  const result = await tools.invoke('whatsapp_send_message', { chatId: JID, message: 'Hello' });
  assert.equal(JSON.parse(result.content[0].text).messageId, 'abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + BASE_ENV.WHATSAPP_API_TOKEN);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].url, 'http://127.0.0.1:37100/accounts/default/send');
  assert.equal(JSON.parse(calls[0].options.body).chatId, JID);
  await assert.rejects(tools.invoke('whatsapp_send_message', { chatId: '123@s.whatsapp.net', message: 'oops' }), /WHATSAPP_SCOPES/);
  await assert.rejects(createWhatsAppTools({
    env: { ...BASE_ENV, WHATSAPP_MCP_SEND_ENABLED: '0' }, fetchImpl,
  }).invoke('whatsapp_send_message', { chatId: JID, message: 'no' }), /disabled/);
  assert.equal(calls.length, 1);
});

test('groups require a second opt-in; wildcard is forbidden', async () => {
  const group = '12345@g.us';
  assert.throws(() => createWhatsAppTools({ env: { ...BASE_ENV, WHATSAPP_MCP_ALLOWED_CHATS: '*' } }), /Wildcard/);
  const tools = createWhatsAppTools({ env: { ...BASE_ENV, WHATSAPP_SCOPES: JSON.stringify({ default: { sendChats: [group] } }) } });
  await assert.rejects(tools.invoke('whatsapp_send_message', { chatId: group, message: 'no' }), /Group access/);
});

test('recent messages read an allowlisted persisted inbox without calling /messages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-inbox-'));
  const file = path.join(dir, 'inbox.jsonl');
  try {
    const events = [
      { ts: 't1', allowed: true, chatId: JID, body: 'first' },
      { ts: 't2', allowed: false, chatId: JID, body: 'denied' },
      { ts: 't3', allowed: true, chatId: 'other@s.whatsapp.net', body: 'private' },
      { ts: 't4', allowed: true, chatId: JID, body: 'last', messageId: 'a' },
    ];
    await writeFile(file, events.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const got = await readRecentInbox(file, new Set([JID]), 10);
    assert.deepEqual(got.map((m) => m.body), ['last', 'first']);
    const tools = createWhatsAppTools({
      env: { ...BASE_ENV, WHATSAPP_INBOX_PATH: file },
      fetchImpl: () => { throw new Error('Should not fetch messages'); },
    });
    const response = await tools.invoke('whatsapp_recent_messages', { limit: 1 });
    assert.equal(JSON.parse(response.content[0].text)[0].messageId, 'a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status hides bridge session filesystem paths', async () => {
  const tools = createWhatsAppTools({
    env: BASE_ENV,
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'connected', session: '/sensitive/session/creds',
      accounts: [{ name: 'primary', status: 'connected', session: '/secret' }],
    }), { status: 200 }),
  });
  const response = await tools.invoke('whatsapp_status');
  assert.deepEqual(JSON.parse(response.content[0].text).accounts, [{ name: 'primary', status: 'connected' }]);
  assert.doesNotMatch(response.content[0].text, /secret|sensitive/);
});

test('stdio server responds to initialize and lists tools', async () => {
  const child = spawn(process.execPath, [new URL('../mcp/server.mjs', import.meta.url).pathname], {
    env: { ...process.env, WHATSAPP_MCP_ALLOWED_CHATS: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (buf) => { output += buf.toString(); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(exitCode, 0);
  const messages = output.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 2);
  assert.equal(messages.find((m) => m.id === 1).result.serverInfo.name, 'whatsapp-agent-bridge');
  assert.ok(messages.find((m) => m.id === 2).result.tools.find((t) => t.name === 'whatsapp_send_message'));
});
