import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWhatsAppTools, readRecentInbox } from '../mcp/tools.mjs';
import { parseAccessScopes } from '../access_scopes.js';

const DM = '15550000001@s.whatsapp.net';
const LID = '15550000002@lid';
const OTHER_DM = '15550000003@s.whatsapp.net';
const GROUP = '15550000004-123@g.us';
const BASE = 'http://127.0.0.1:37100';
const decode = (result) => JSON.parse(result.content[0].text);
const toolArgs = [
  ['whatsapp_status', {}],
  ['whatsapp_recent_messages', {}],
  ['whatsapp_chat_info', { chatId: DM }],
  ['whatsapp_send_message', { chatId: DM, message: 'Fixture message' }],
];

function setup(scopes, extraEnv = {}, payload = { success: true }) {
  const calls = [];
  const env = {
    WHATSAPP_BRIDGE_URL: BASE,
    WHATSAPP_SCOPES: JSON.stringify(scopes),
    WHATSAPP_MCP_SEND_ENABLED: '1',
    ...extraEnv,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { env, fetchImpl, calls, tools: createWhatsAppTools({ env, fetchImpl }) };
}

async function inbox(t, entries) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-scopes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'inbox.jsonl');
  const contents = typeof entries === 'string' ? entries : entries.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(filename, contents);
  return filename;
}

test('all-DM reading accepts private JIDs but only the separate send list permits sending', async () => {
  const x = setup({ default: { readAllDms: true, triggerChats: [LID], sendChats: [LID] } });
  for (const chatId of [DM, LID, OTHER_DM]) await x.tools.invoke('whatsapp_chat_info', { chatId });
  await x.tools.invoke('whatsapp_send_message', { chatId: LID, message: 'Fixture message' });
  for (const chatId of [DM, OTHER_DM, GROUP, '*', '15550000001', 'x@broadcast']) {
    await assert.rejects(x.tools.invoke('whatsapp_send_message', { chatId, message: 'No' }), /WHATSAPP_SCOPES/);
  }
  await assert.rejects(x.tools.invoke('whatsapp_chat_info', { chatId: GROUP }), /WHATSAPP_SCOPES/);
  assert.equal(x.calls.length, 4);
  assert.equal(x.calls[0].url, `${BASE}/accounts/default/chat/${encodeURIComponent(DM)}`);
  assert.equal(x.calls[3].url, `${BASE}/accounts/default/send`);
  assert.deepEqual(JSON.parse(x.calls[3].options.body), { chatId: LID, message: 'Fixture message' });
});

test('read, trigger, and legacy allowlists cannot widen an explicit send scope', async () => {
  const x = setup({ primary: { readChats: [DM], triggerChats: [LID] } }, {
    WHATSAPP_MCP_ALLOWED_CHATS: `${DM},${LID},${OTHER_DM}`,
  });
  await x.tools.invoke('whatsapp_chat_info', { chatId: DM });
  for (const chatId of [DM, LID, OTHER_DM]) {
    await assert.rejects(x.tools.invoke('whatsapp_send_message', { chatId, message: 'No' }), /WHATSAPP_SCOPES/);
  }
  for (const chatId of [LID, OTHER_DM]) {
    await assert.rejects(x.tools.invoke('whatsapp_chat_info', { chatId }), /WHATSAPP_SCOPES/);
  }
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].url, `${BASE}/accounts/primary/chat/${encodeURIComponent(DM)}`);
});

test('a send-only destination works without granting metadata or inbox access', async (t) => {
  const filename = await inbox(t, [{ account: 'primary', readAllowed: true, allowed: true, chatId: LID, body: 'Private' }]);
  const x = setup({ primary: { sendChats: [LID] } }, { WHATSAPP_INBOX_PATH: filename });
  await x.tools.invoke('whatsapp_send_message', { chatId: LID, message: 'Fixture message' });
  await assert.rejects(x.tools.invoke('whatsapp_chat_info', { chatId: LID }), /WHATSAPP_SCOPES/);
  assert.deepEqual(decode(await x.tools.invoke('whatsapp_recent_messages')), []);
  assert.equal(x.calls.length, 1);
});

test('scoped sends still require the global send switch and a valid message', async () => {
  for (const value of [undefined, '', '0', 'true']) {
    const x = setup({ default: { sendChats: [DM] } }, { WHATSAPP_MCP_SEND_ENABLED: value });
    await assert.rejects(x.tools.invoke('whatsapp_send_message', { chatId: DM, message: 'No' }), /disabled/);
    assert.equal(x.calls.length, 0);
  }
  const x = setup({ default: { sendChats: [DM] } });
  for (const message of ['', ' ', null, 42, 'a'.repeat(4097)]) {
    await assert.rejects(x.tools.invoke('whatsapp_send_message', { chatId: DM, message }), /Message/);
  }
  assert.equal(x.calls.length, 0);
});

test('every scoped tool rejects missing ambiguous, unknown, and invalid accounts before any I/O', async () => {
  let reads = 0;
  const x = setup({ alpha: { readAllDms: true, sendChats: [DM] }, beta: { readAllDms: true, sendChats: [DM] } });
  const tools = createWhatsAppTools({
    env: x.env, fetchImpl: x.fetchImpl, inboxReader: async () => { reads++; return []; },
  });
  for (const [name, args] of toolArgs) {
    await assert.rejects(tools.invoke(name, args), /explicit account/);
    for (const account of ['other', 'Alpha', '', null, 42, '../alpha', 'alpha/beta']) {
      await assert.rejects(tools.invoke(name, { ...args, account }), /account/i);
    }
  }
  assert.equal(x.calls.length, 0);
  assert.equal(reads, 0);
});

test('a sole scoped account is the only default and is never a wildcard account grant', async () => {
  let reads = 0;
  const x = setup({ named: { readChats: [DM], sendChats: [DM] } });
  const tools = createWhatsAppTools({
    env: x.env, fetchImpl: x.fetchImpl,
    inboxReader: async (_filename, _allowed, _limit, options) => {
      reads++;
      assert.equal(options.account, 'named');
      return [];
    },
  });
  for (const [name, args] of toolArgs) {
    await tools.invoke(name, args);
    for (const account of ['default', 'other', 'Named', '', null]) {
      await assert.rejects(tools.invoke(name, { ...args, account }), /account/i);
    }
  }
  assert.equal(reads, 1);
  assert.equal(x.calls.length, 3);
  assert.ok(x.calls.every(({ url }) => url.startsWith(`${BASE}/accounts/named/`)));
});

test('identical chat IDs across accounts do not share read or send permissions', async () => {
  const x = setup({ alpha: { readChats: [DM] }, beta: { sendChats: [DM] } });
  await x.tools.invoke('whatsapp_chat_info', { account: 'alpha', chatId: DM });
  await x.tools.invoke('whatsapp_send_message', { account: 'beta', chatId: DM, message: 'Fixture message' });
  await assert.rejects(x.tools.invoke('whatsapp_chat_info', { account: 'beta', chatId: DM }), /WHATSAPP_SCOPES/);
  await assert.rejects(x.tools.invoke('whatsapp_send_message', { account: 'alpha', chatId: DM, message: 'No' }), /WHATSAPP_SCOPES/);
  assert.deepEqual(x.calls.map(({ url }) => url), [
    `${BASE}/accounts/alpha/chat/${encodeURIComponent(DM)}`, `${BASE}/accounts/beta/send`,
  ]);
});

test('an explicit empty account map denies every tool rather than falling back to legacy', async () => {
  let reads = 0;
  const x = setup({}, { WHATSAPP_MCP_ALLOWED_CHATS: DM });
  const tools = createWhatsAppTools({
    env: x.env, fetchImpl: x.fetchImpl, inboxReader: async () => { reads++; return []; },
  });
  for (const [name, args] of toolArgs) {
    await assert.rejects(tools.invoke(name, args), /account/i);
    await assert.rejects(tools.invoke(name, { ...args, account: 'default' }), /account/i);
  }
  assert.equal(reads, 0);
  assert.equal(x.calls.length, 0);
});

test('missing policy fields deny chat access while allowing only the named account status', async (t) => {
  const filename = await inbox(t, [{ account: 'default', readAllowed: true, chatId: DM, body: 'Private' }]);
  const x = setup({ default: {} }, { WHATSAPP_MCP_ALLOWED_CHATS: DM, WHATSAPP_INBOX_PATH: filename });
  await x.tools.invoke('whatsapp_status');
  assert.deepEqual(decode(await x.tools.invoke('whatsapp_recent_messages')), []);
  await assert.rejects(x.tools.invoke('whatsapp_chat_info', { chatId: DM }), /WHATSAPP_SCOPES/);
  await assert.rejects(x.tools.invoke('whatsapp_send_message', { chatId: DM, message: 'No' }), /WHATSAPP_SCOPES/);
  assert.equal(x.calls.length, 1);
});

test('malformed policies, wildcard grants, and invalid JIDs fail at adapter construction', () => {
  const invalid = [
    '{broken', 'null', '[]', 'true', '42', '"default"',
    JSON.stringify({ 'bad/account': {} }),
    JSON.stringify({ default: null }),
    JSON.stringify({ default: [] }),
    JSON.stringify({ default: { unexpected: true } }),
    ...['true', 1, null, '*', []].map((value) => JSON.stringify({ default: { readAllDms: value } })),
    ...['readChats', 'triggerChats', 'sendChats'].flatMap((field) => [
      JSON.stringify({ default: { [field]: '*' } }),
      ...['*', '*@lid', '15550000001', 'x@broadcast', 'x@lid/other', 42, null].map((chatId) =>
        JSON.stringify({ default: { [field]: [chatId] } })),
    ]),
    JSON.stringify({ default: { triggerChats: [GROUP] } }),
  ];
  for (const value of invalid) {
    assert.throws(() => createWhatsAppTools({ env: { WHATSAPP_SCOPES: value } }), /WHATSAPP_SCOPES/, value);
  }
});

test('groups require both the explicit operation grant and the MCP group switch', async () => {
  const policy = { default: { readChats: [GROUP], sendChats: [GROUP] } };
  const disabled = setup(policy);
  await assert.rejects(disabled.tools.invoke('whatsapp_chat_info', { chatId: GROUP }), /Group access/);
  await assert.rejects(disabled.tools.invoke('whatsapp_send_message', { chatId: GROUP, message: 'No' }), /Group access/);
  assert.equal(disabled.calls.length, 0);
  const enabled = setup(policy, { WHATSAPP_MCP_ALLOW_GROUPS: '1' });
  await enabled.tools.invoke('whatsapp_chat_info', { chatId: GROUP });
  await enabled.tools.invoke('whatsapp_send_message', { chatId: GROUP, message: 'Fixture message' });
  assert.equal(enabled.calls.length, 2);
  const allDms = setup({ default: { readAllDms: true, sendChats: [GROUP] } }, { WHATSAPP_MCP_ALLOW_GROUPS: '1' });
  await assert.rejects(allDms.tools.invoke('whatsapp_chat_info', { chatId: GROUP }), /WHATSAPP_SCOPES/);
  assert.equal(allDms.calls.length, 0);
});

test('recent messages select the exact account and use readAllowed independently of trigger eligibility', async (t) => {
  const filename = await inbox(t, [
    { account: 'alpha', readAllowed: true, allowed: false, chatId: DM, body: 'Read without trigger' },
    { account: 'beta', readAllowed: true, allowed: true, chatId: DM, body: 'Other account' },
    { account: 'alpha', readAllowed: false, allowed: true, chatId: DM, body: 'Denied read' },
    { account: 'alpha', readAllowed: null, allowed: true, chatId: DM, body: 'Invalid read flag' },
    { account: 'alpha', allowed: true, chatId: LID, body: 'Old allowed row' },
    { account: 'alpha', allowed: false, chatId: LID, body: 'Old denied row' },
    { account: 'alpha', readAllowed: 'true', allowed: true, chatId: DM, body: 'Invalid true flag' },
    { readAllowed: true, allowed: true, chatId: DM, body: 'Unlabeled old row' },
    null,
  ]);
  const x = setup({ alpha: { readAllDms: true }, beta: { readAllDms: true } }, { WHATSAPP_INBOX_PATH: filename });
  const alpha = decode(await x.tools.invoke('whatsapp_recent_messages', { account: 'alpha' }));
  assert.deepEqual(alpha.map((row) => row.body), ['Old allowed row', 'Read without trigger']);
  assert.ok(alpha.every((row) => row.account === 'alpha'));
  const beta = decode(await x.tools.invoke('whatsapp_recent_messages', { account: 'beta' }));
  assert.deepEqual(beta.map((row) => row.body), ['Other account']);
  assert.equal(x.calls.length, 0);
});

test('only a selected default account may read unlabeled legacy rows', async (t) => {
  const filename = await inbox(t, [
    { allowed: true, chatId: DM, body: 'No account label' },
    { account: null, allowed: true, chatId: DM, body: 'Null old account' },
    { account: 'default', readAllowed: true, chatId: DM, body: 'Explicit default' },
    { account: '', allowed: true, chatId: DM, body: 'Invalid empty account' },
    { account: 'named', readAllowed: true, chatId: DM, body: 'Named account' },
  ]);
  const x = setup({ default: { readAllDms: true }, named: { readAllDms: true } }, { WHATSAPP_INBOX_PATH: filename });
  const defaults = decode(await x.tools.invoke('whatsapp_recent_messages', { account: 'default' }));
  assert.deepEqual(defaults.map((row) => row.body), ['Explicit default', 'Null old account', 'No account label']);
  assert.deepEqual(defaults.map((row) => row.account), ['default', null, null]);
  const named = decode(await x.tools.invoke('whatsapp_recent_messages', { account: 'named' }));
  assert.deepEqual(named.map((row) => row.body), ['Named account']);
  const soleNamed = setup({ named: { readAllDms: true } }, { WHATSAPP_INBOX_PATH: filename });
  assert.deepEqual(decode(await soleNamed.tools.invoke('whatsapp_recent_messages')).map((row) => row.body), ['Named account']);
});

test('current read scope, account, and group checks run before the recent-message limit', async (t) => {
  const filename = await inbox(t, [
    { account: 'alpha', allowed: true, chatId: DM, body: 'Kept old record' },
    { account: 'alpha', readAllowed: true, allowed: false, chatId: DM, body: 'Kept new record' },
    ...Array.from({ length: 25 }, (_, i) => [
      { account: 'beta', readAllowed: true, chatId: DM, body: `Other account ${i}` },
      { account: 'alpha', readAllowed: true, chatId: OTHER_DM, body: `Revoked read ${i}` },
      { account: 'alpha', readAllowed: true, chatId: GROUP, body: `Group disabled ${i}` },
      { account: 'alpha', readAllowed: false, allowed: true, chatId: DM, body: `Stored read denied ${i}` },
    ]).flat(),
  ]);
  const x = setup({ alpha: { readChats: [DM, GROUP] } }, { WHATSAPP_INBOX_PATH: filename });
  const rows = decode(await x.tools.invoke('whatsapp_recent_messages', { limit: 2 }));
  assert.deepEqual(rows.map((row) => row.body), ['Kept new record', 'Kept old record']);
  const groups = setup({ alpha: { readChats: [GROUP] } }, {
    WHATSAPP_INBOX_PATH: filename, WHATSAPP_MCP_ALLOW_GROUPS: '1',
  });
  assert.equal(decode(await groups.tools.invoke('whatsapp_recent_messages', { limit: 1 }))[0].body, 'Group disabled 24');
  const allDms = setup({ alpha: { readAllDms: true } }, {
    WHATSAPP_INBOX_PATH: filename, WHATSAPP_MCP_ALLOW_GROUPS: '1',
  });
  assert.ok(decode(await allDms.tools.invoke('whatsapp_recent_messages')).every((row) => row.chatId !== GROUP));
});

test('recent reads are bounded to 20 messages from the last 512 KiB', async (t) => {
  const row = (body) => JSON.stringify({ account: 'default', readAllowed: true, chatId: DM, body });
  const recent = Array.from({ length: 25 }, (_, i) => row(`Recent ${i}`));
  const filename = await inbox(t, `${row('Outside byte window')}\n${'x'.repeat(512 * 1024)}\n${recent.join('\n')}\n`);
  const x = setup({ default: { readAllDms: true } }, { WHATSAPP_INBOX_PATH: filename });
  const rows = decode(await x.tools.invoke('whatsapp_recent_messages', { limit: 20 }));
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map((entry) => entry.body), Array.from({ length: 20 }, (_, i) => `Recent ${24 - i}`));
  assert.equal(decode(await x.tools.invoke('whatsapp_recent_messages')).length, 10);
  for (const limit of [0, -1, 21, 1.5, '2']) {
    await assert.rejects(x.tools.invoke('whatsapp_recent_messages', { limit }), /1\.\.20/);
    await assert.rejects(readRecentInbox(filename, new Set([DM]), limit), /1\.\.20/);
  }
  const noRecent = await inbox(t, `${row('Outside byte window')}\n${'x'.repeat(512 * 1024)}`);
  const scope = parseAccessScopes(JSON.stringify({ default: { readAllDms: true } })).get('default');
  assert.deepEqual(await readRecentInbox(noRecent, new Set(), 20, { scope, account: 'default' }), []);
});

test('scoped inbox reader receives options and its returned rows cannot widen account or current read access', async () => {
  const x = setup({ named: { readChats: [DM] } });
  let received;
  const tools = createWhatsAppTools({
    env: x.env, fetchImpl: x.fetchImpl,
    inboxReader: async (...args) => {
      received = args;
      return [
        { account: 'other', chatId: DM },
        { account: null, chatId: DM },
        { account: 'named', chatId: OTHER_DM },
        { account: 'named', chatId: GROUP },
        { account: 'named', chatId: DM, body: 'Allowed' },
      ];
    },
  });
  assert.deepEqual(decode(await tools.invoke('whatsapp_recent_messages', { limit: 1 })), [
    { account: 'named', chatId: DM, body: 'Allowed' },
  ]);
  assert.equal(received.length, 4);
  assert.deepEqual([...received[1]], [DM]);
  assert.equal(received[2], 1);
  assert.equal(received[3].account, 'named');
  assert.equal(received[3].scope.readAllDms, false);
  assert.equal(received[3].allowGroups, false);
  assert.equal(x.calls.length, 0);
  assert.equal(tools.definitions.find(({ name }) => name === 'whatsapp_recent_messages').inputSchema.properties.account.type, 'string');
});

test('scoped status exposes only selected account status and queue count, including on errors', async () => {
  const x = setup({ named: {} }, {}, {
    status: 'connected', queueLength: 2, account: 'named', session: '/private/session',
    allConnected: false, defaultAccount: 'other', accounts: [{ name: 'other', status: 'disconnected', session: '/private/other' }],
  });
  assert.deepEqual(decode(await x.tools.invoke('whatsapp_status')), { account: 'named', status: 'connected', queueLength: 2 });
  assert.equal(x.calls[0].url, `${BASE}/accounts/named/health`);
  const tools = createWhatsAppTools({
    env: x.env,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Other account secret session /private/other' }), { status: 404 }),
  });
  await assert.rejects(tools.invoke('whatsapp_status'), (error) => {
    assert.match(error.message, /HTTP 404/);
    assert.doesNotMatch(error.message, /Other|secret|private/);
    return true;
  });
});

test('unset and empty scope settings preserve legacy routes and allowlist behavior', async () => {
  for (const value of [undefined, '', '   ']) {
    const x = setup({}, { WHATSAPP_SCOPES: value, WHATSAPP_MCP_ALLOWED_CHATS: DM });
    await x.tools.invoke('whatsapp_chat_info', { chatId: DM });
    await x.tools.invoke('whatsapp_send_message', { chatId: DM, message: 'Fixture message' });
    await x.tools.invoke('whatsapp_status');
    await assert.rejects(x.tools.invoke('whatsapp_chat_info', { chatId: LID }), /WHATSAPP_MCP_ALLOWED_CHATS/);
    assert.deepEqual(x.calls.map(({ url }) => url), [
      `${BASE}/chat/${encodeURIComponent(DM)}`, `${BASE}/send`, `${BASE}/health`,
    ]);
  }
});
