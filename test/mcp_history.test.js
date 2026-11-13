import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppTools } from '../mcp/tools.mjs';

const DM = '15550000001@s.whatsapp.net';
const LID = '15550000002@lid';
const OTHER = '15550000003@s.whatsapp.net';
const GROUP = '15550000004-123@g.us';
const BASE = 'http://127.0.0.1:37100';
const TOKEN = 'fixture-history-token-not-a-secret-0001';
const CURSOR = 'c25hcHNob3Qtb2Zmc2V0.c2lnbmF0dXJl';
const decode = (result) => JSON.parse(result.content[0].text);
const historyTools = [
  ['whatsapp_list_chats', {}],
  ['whatsapp_chat_messages', { chatId: DM }],
  ['whatsapp_request_history', { chatId: DM, count: 10 }],
];
const chat = (chatId = DM, extra = {}) => ({
  chatId, name: 'Fixture chat', isGroup: chatId.endsWith('@g.us'),
  lastMessageTimestamp: 1700000000, messageCount: 2, ...extra,
});
const message = (chatId = DM, extra = {}) => ({
  messageId: 'fixture-message', chatId, senderId: DM, fromMe: false,
  timestamp: 1700000000, body: 'Fixture text', hasMedia: false, mediaType: null, ...extra,
});
const page = (extra = {}) => ({
  chats: [], messages: [], chatId: DM, nextCursor: null, source: 'local-cache', complete: false, ...extra,
});

function setup({ scopes = { primary: { readChats: [DM] } }, env: extraEnv = {}, payload = page(), status = 200 } = {}) {
  const calls = [];
  const env = {
    WHATSAPP_API_TOKEN: TOKEN,
    WHATSAPP_BRIDGE_URL: BASE,
    WHATSAPP_SCOPES: scopes === null ? undefined : JSON.stringify(scopes),
    ...extraEnv,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const value = typeof payload === 'function' ? payload(calls.length, url, options) : payload;
    return new Response(JSON.stringify(value), { status });
  };
  return { calls, tools: createWhatsAppTools({ env, fetchImpl }) };
}

const enabled = { WHATSAPP_MCP_HISTORY_BACKFILL_ENABLED: '1' };

test('all seven tools remain discoverable and cached reads are distinct from provider requests', async () => {
  const x = setup();
  assert.equal(x.tools.definitions.length, 7);
  for (const name of ['whatsapp_list_chats', 'whatsapp_chat_messages']) {
    const definition = x.tools.definitions.find((tool) => tool.name === name);
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.inputSchema.properties.limit.maximum, 100);
    assert.equal(definition.inputSchema.properties.cursor.maxLength, 1024);
    assert.match(CURSOR, new RegExp(definition.inputSchema.properties.cursor.pattern));
  }
  const backfill = x.tools.definitions.find((tool) => tool.name === 'whatsapp_request_history');
  assert.equal(backfill.annotations.readOnlyHint, false);
  assert.deepEqual(backfill.inputSchema.required, ['chatId', 'count']);
  await assert.rejects(x.tools.invoke('whatsapp_unknown'), /Unknown WhatsApp MCP tool/);
  assert.equal(x.calls.length, 0);
});

test('new history tools require explicit scopes and never inherit the legacy allowlist', async () => {
  for (const scopeValue of [undefined, '', '  ']) {
    const x = setup({ scopes: null, env: {
      ...enabled, WHATSAPP_SCOPES: scopeValue, WHATSAPP_MCP_ALLOWED_CHATS: DM,
    } });
    for (const [name, args] of historyTools) {
      await assert.rejects(x.tools.invoke(name, args), /explicit WHATSAPP_SCOPES/);
    }
    assert.equal(x.calls.length, 0);
  }
});

test('empty or send/trigger-only scopes cannot authorize history', async () => {
  for (const scopes of [{}, { primary: {} }, { primary: { sendChats: [DM], triggerChats: [DM] } }]) {
    const x = setup({ scopes, env: { ...enabled, WHATSAPP_MCP_ALLOWED_CHATS: DM } });
    for (const [name, args] of historyTools) {
      await assert.rejects(x.tools.invoke(name, args), /WHATSAPP_SCOPES/);
    }
    assert.equal(x.calls.length, 0);
  }
});

test('history requires an exact authorized account and rejects ambiguous selection before I/O', async () => {
  const x = setup({ scopes: { alpha: { readAllDms: true }, beta: { readAllDms: true } }, env: enabled });
  for (const [name, args] of historyTools) {
    await assert.rejects(x.tools.invoke(name, args), /explicit account/);
    for (const account of [null, '', 1, {}, 'other', 'Alpha', '../alpha', 'alpha/beta', 'a'.repeat(65)]) {
      await assert.rejects(x.tools.invoke(name, { ...args, account }), /account/i);
    }
  }
  assert.equal(x.calls.length, 0);
});

test('the same JID in different accounts does not share read permissions', async () => {
  const x = setup({ scopes: { alpha: { readChats: [DM] }, beta: { sendChats: [DM] } }, env: enabled });
  await x.tools.invoke('whatsapp_chat_messages', { account: 'alpha', chatId: DM });
  for (const [name, args] of historyTools) {
    await assert.rejects(x.tools.invoke(name, { ...args, account: 'beta' }), /WHATSAPP_SCOPES/);
  }
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].url, `${BASE}/accounts/alpha/chat/${encodeURIComponent(DM)}/messages?limit=20`);
});

test('list pages apply narrower MCP scopes and a primitive allowlisted response shape', async () => {
  const x = setup({ payload: page({
    account: 'primary', source: '/private/cache.sqlite', complete: true,
    sessionPath: '/private/session', raw: { owner: 'provider metadata' },
    chats: [
      chat(OTHER, { name: 'DENIED NAME' }),
      chat(GROUP, { isGroup: false, name: 'DENIED GROUP' }),
      chat(DM, { account: 'other', name: 'DENIED ACCOUNT' }),
      chat('not-a-jid', { name: 'DENIED INVALID' }),
      null,
      chat(DM, { isGroup: true, raw: { key: 'private' }, mediaPath: '/private/media' }),
    ],
  }) });
  const result = await x.tools.invoke('whatsapp_list_chats');
  assert.deepEqual(decode(result), {
    account: 'primary', chats: [chat()], nextCursor: null, source: 'local-cache', complete: false,
  });
  assert.doesNotMatch(result.content[0].text, /DENIED|private|provider|not-a-jid/);
  assert.ok(!result.content[0].text.includes(OTHER));
  assert.ok(!result.content[0].text.includes(GROUP));
  assert.equal(x.calls[0].url, `${BASE}/accounts/primary/chats?limit=20&groups=0`);
});

test('sparse and empty pages keep the bridge cursor instead of ending or silently scanning ahead', async () => {
  const x = setup({ payload: (call) => call === 1
    ? page({ chats: [chat(OTHER)], nextCursor: CURSOR })
    : page({ chats: [chat()] }),
  });
  const first = decode(await x.tools.invoke('whatsapp_list_chats', { limit: 1 }));
  assert.deepEqual(first.chats, []);
  assert.equal(first.nextCursor, CURSOR);
  assert.equal(x.calls.length, 1);
  const second = decode(await x.tools.invoke('whatsapp_list_chats', { limit: 1, cursor: first.nextCursor }));
  assert.deepEqual(second.chats, [chat()]);
  assert.equal(second.nextCursor, null);
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[1].url, `${BASE}/accounts/primary/chats?limit=1&cursor=${CURSOR}&groups=0`);
});

test('list group inclusion needs both request and global opt-ins plus an explicit read grant', async () => {
  const scopes = { primary: { readAllDms: true, readChats: [GROUP] } };
  const payload = page({ chats: [chat(), chat(LID), chat(GROUP)] });
  const disabled = setup({ scopes, payload });
  await assert.rejects(disabled.tools.invoke('whatsapp_list_chats', { groups: true }), /Group access/);
  assert.equal(disabled.calls.length, 0);
  const x = setup({ scopes, payload, env: { WHATSAPP_MCP_ALLOW_GROUPS: '1' } });
  assert.deepEqual(decode(await x.tools.invoke('whatsapp_list_chats')).chats.map((row) => row.chatId), [DM, LID]);
  const included = decode(await x.tools.invoke('whatsapp_list_chats', { groups: true }));
  assert.deepEqual(included.chats.map((row) => row.chatId), [DM, LID, GROUP]);
  assert.equal(x.calls[1].url, `${BASE}/accounts/primary/chats?limit=20&groups=1`);
  const allDms = setup({ scopes: { primary: { readAllDms: true } }, payload, env: { WHATSAPP_MCP_ALLOW_GROUPS: '1' } });
  assert.deepEqual(decode(await allDms.tools.invoke('whatsapp_list_chats', { groups: true })).chats.map((row) => row.chatId), [DM, LID]);
});

test('message pages recheck each record account/chat and never expose provider metadata or paths', async () => {
  const x = setup({ scopes: { primary: { readChats: [DM, LID] } }, payload: page({
    account: 'primary', sessionPath: '/private/session', nextCursor: CURSOR,
    messages: [
      message(DM, { account: 'other', body: 'DENIED ACCOUNT' }),
      message(LID, { body: 'OTHER READABLE CHAT' }),
      message(OTHER, { body: 'DENIED CHAT' }),
      message(GROUP, { body: 'DENIED GROUP' }),
      message(DM, { messageId: { raw: '/private/key' }, body: 'INVALID ID' }),
      null,
      message(DM, { raw: { key: 'private' }, mediaPath: '/private/media', provider: { secret: true } }),
    ],
  }) });
  const result = await x.tools.invoke('whatsapp_chat_messages', { chatId: DM, cursor: CURSOR, limit: 10 });
  assert.deepEqual(decode(result), {
    account: 'primary', chatId: DM, messages: [message()], nextCursor: CURSOR, source: 'local-cache', complete: false,
  });
  assert.doesNotMatch(result.content[0].text, /DENIED|OTHER READABLE|INVALID ID|private|provider|mediaPath/);
  assert.equal(x.calls[0].url, `${BASE}/accounts/primary/chat/${encodeURIComponent(DM)}/messages?limit=10&cursor=${CURSOR}`);
});

test('unexpected nested response values cannot bypass field projection', async () => {
  const raw = { filePath: '/private/path', raw: 'provider data' };
  const x = setup({ payload: page({
    chats: [chat(DM, { name: raw, lastMessageTimestamp: raw, messageCount: raw })],
    messages: [message(DM, { senderId: '/private/path', timestamp: raw, body: raw, hasMedia: raw, fromMe: raw, mediaType: raw })],
  }) });
  const list = decode(await x.tools.invoke('whatsapp_list_chats'));
  assert.deepEqual(list.chats, [chat(DM, { name: null, lastMessageTimestamp: null, messageCount: 0 })]);
  const messages = decode(await x.tools.invoke('whatsapp_chat_messages', { chatId: DM }));
  assert.deepEqual(messages.messages, [message(DM, { senderId: null, timestamp: null, body: null })]);
  assert.doesNotMatch(JSON.stringify({ list, messages }), /private|provider|filePath/);
});

test('readAllDms includes LID chats but grants neither arbitrary JIDs nor groups', async () => {
  const x = setup({ scopes: { primary: { readAllDms: true } }, payload: page({ chatId: LID }), env: enabled });
  await x.tools.invoke('whatsapp_chat_messages', { chatId: LID });
  for (const chatId of [GROUP, '*', '123', 'x@broadcast', '../secret', `${DM}/messages`, `${DM}\n`, `${GROUP}\n`, `${'x'.repeat(256)}@lid`, null, 42]) {
    await assert.rejects(x.tools.invoke('whatsapp_chat_messages', { chatId }), /WHATSAPP_SCOPES/);
    await assert.rejects(x.tools.invoke('whatsapp_request_history', { chatId, count: 1 }), /WHATSAPP_SCOPES/);
  }
  assert.equal(x.calls.length, 1);
});

test('single-chat history and backfill retain the separate group opt-in', async () => {
  const scopes = { primary: { readChats: [GROUP] } };
  const x = setup({ scopes, env: enabled });
  for (const name of ['whatsapp_chat_messages', 'whatsapp_request_history']) {
    await assert.rejects(x.tools.invoke(name, { chatId: GROUP, ...(name === 'whatsapp_request_history' ? { count: 1 } : {}) }), /Group access/);
  }
  assert.equal(x.calls.length, 0);
  const allowed = setup({ scopes, env: { ...enabled, WHATSAPP_MCP_ALLOW_GROUPS: '1' }, payload: page({ chatId: GROUP }) });
  await allowed.tools.invoke('whatsapp_chat_messages', { chatId: GROUP });
  assert.equal(allowed.calls.length, 1);
});

test('history reads reject invalid limits, cursors, group flags and additional arguments before I/O', async () => {
  const x = setup();
  for (const [name, args] of historyTools.slice(0, 2)) {
    for (const limit of [0, -1, 101, 1.5, '20', null, false, Infinity, NaN]) {
      await assert.rejects(x.tools.invoke(name, { ...args, limit }), /1\.\.100/);
    }
    for (const cursor of ['', null, 3, {}, [], 'abc', 'a.b.c', 'a/b.c', 'a=.b', 'a.b\n', 'a'.repeat(1023) + '.b']) {
      await assert.rejects(x.tools.invoke(name, { ...args, cursor }), /cursor/);
    }
    await assert.rejects(x.tools.invoke(name, { ...args, path: '/private/file' }), /Unexpected/);
  }
  for (const groups of ['1', 'true', 1, null, {}, []]) {
    await assert.rejects(x.tools.invoke('whatsapp_list_chats', { groups }), /boolean/);
  }
  for (const args of [null, [], 1, '']) await assert.rejects(x.tools.invoke('whatsapp_list_chats', args), /object/);
  assert.equal(x.calls.length, 0);
});

test('read page bounds accept 1 and 100 and cap oversized bridge responses', async () => {
  const x = setup({ payload: page({ chats: Array(105).fill(chat()), messages: Array(105).fill(message()) }) });
  for (const limit of [1, 100]) {
    const chats = decode(await x.tools.invoke('whatsapp_list_chats', { limit }));
    const messages = decode(await x.tools.invoke('whatsapp_chat_messages', { chatId: DM, limit }));
    assert.equal(chats.chats.length, limit);
    assert.equal(messages.messages.length, limit);
  }
  const cursor = 'a'.repeat(1022) + '.b';
  await x.tools.invoke('whatsapp_list_chats', { cursor });
  assert.ok(x.calls.at(-1).url.includes(`cursor=${cursor}`));
});

test('all history HTTP requests use the bridge bearer token and reject redirects', async () => {
  const x = setup({ env: enabled, payload: page({ requested: true, requestId: 'fixture-request', status: 'requested' }) });
  for (const [name, args] of historyTools) await x.tools.invoke(name, args);
  for (const { options } of x.calls) {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
  for (const token of [undefined, '', 'short', 'invalid token with spaces']) {
    const invalid = setup({ env: { ...enabled, WHATSAPP_API_TOKEN: token } });
    for (const [name, args] of historyTools) await assert.rejects(invalid.tools.invoke(name, args), /WHATSAPP_API_TOKEN/);
    assert.equal(invalid.calls.length, 0);
  }
});

test('backfill defaults off and only the exact independent opt-in enables requests', async () => {
  for (const flag of [undefined, '', '0', 'true', true, 1]) {
    const x = setup({ env: {
      WHATSAPP_MCP_HISTORY_BACKFILL_ENABLED: flag, WHATSAPP_MCP_SEND_ENABLED: '1', WHATSAPP_HISTORY_BACKFILL_ENABLED: '1',
    } });
    await assert.rejects(x.tools.invoke('whatsapp_request_history', { chatId: DM, count: 1 }), /backfill is disabled/);
    assert.equal(x.calls.length, 0);
  }
});

test('backfill validates counts and rejects arbitrary provider anchors before I/O', async () => {
  const x = setup({ env: enabled });
  for (const count of [undefined, null, 0, -1, 51, 1.5, '10', {}, false, Infinity]) {
    await assert.rejects(x.tools.invoke('whatsapp_request_history', { chatId: DM, count }), /1\.\.50/);
  }
  for (const field of ['anchor', 'messageId', 'oldestMsgKey', 'timestamp', 'cursor', 'limit']) {
    await assert.rejects(x.tools.invoke('whatsapp_request_history', { chatId: DM, count: 1, [field]: 'caller supplied' }), /Unexpected/);
  }
  assert.equal(x.calls.length, 0);
});

test('backfill uses only count in an authenticated POST and sanitizes the asynchronous acceptance', async () => {
  const x = setup({ env: enabled, status: 202, payload: {
    requested: true, requestId: 'fixture-request', chatId: DM, count: 50,
    source: 'provider-request', status: 'requested', complete: false,
    anchor: { key: 'private provider data' }, raw: { secret: true }, sessionPath: '/private/session',
  } });
  for (const count of [1, 50]) {
    const result = await x.tools.invoke('whatsapp_request_history', { chatId: DM, count });
    assert.deepEqual(decode(result), {
      account: 'primary', chatId: DM, requested: true, requestId: 'fixture-request', count,
      source: 'provider-request', status: 'requested', complete: false,
    });
    assert.doesNotMatch(result.content[0].text, /private|anchor|sessionPath|secret/);
    const call = x.calls.at(-1);
    assert.equal(call.url, `${BASE}/accounts/primary/chat/${encodeURIComponent(DM)}/history`);
    assert.equal(call.options.method, 'POST');
    assert.deepEqual(JSON.parse(call.options.body), { count });
  }
});

test('bridge errors stay fail-closed without surfacing provider details or retrying', async () => {
  for (const status of [403, 409, 429, 503]) {
    const x = setup({ env: enabled, status, payload: { error: 'Provider private data /private/session', success: false } });
    for (const [name, args] of historyTools) {
      await assert.rejects(x.tools.invoke(name, args), (error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /private|Provider|session/);
        return true;
      });
    }
    assert.equal(x.calls.length, 3);
  }
});

test('mismatched or malformed bridge response envelopes and cursors fail closed', async () => {
  for (const payload of [null, [], page({ account: 'other' }), page({ account: null }), page({ nextCursor: '/private/path' }), page({ nextCursor: {} })]) {
    const x = setup({ payload });
    for (const [name, args] of historyTools.slice(0, 2)) {
      await assert.rejects(x.tools.invoke(name, args), /Invalid history/);
    }
  }
  for (const payload of [page({ chats: {} }), page({ chats: null })]) {
    await assert.rejects(setup({ payload }).tools.invoke('whatsapp_list_chats'), /Invalid history response/);
  }
  for (const payload of [page({ chatId: OTHER }), page({ messages: {} }), page({ messages: null })]) {
    await assert.rejects(setup({ payload }).tools.invoke('whatsapp_chat_messages', { chatId: DM }), /Invalid history response/);
  }
  await assert.rejects(setup({ env: enabled, payload: { chatId: OTHER } }).tools.invoke('whatsapp_request_history', { chatId: DM, count: 1 }), /Invalid history response/);
});


test('history transport and JSON errors do not echo provider text, paths or credentials', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('Provider private data /private/session'); },
    async () => new Response('Provider private data /private/session', { status: 500 }),
  ]) {
    const tools = createWhatsAppTools({
      env: { WHATSAPP_API_TOKEN: TOKEN, WHATSAPP_SCOPES: JSON.stringify({ primary: { readAllDms: true } }), ...enabled },
      fetchImpl,
    });
    for (const [name, args] of historyTools) {
      await assert.rejects(tools.invoke(name, args), (error) => {
        assert.equal(error.message, 'WhatsApp history request failed.');
        return true;
      });
    }
  }
});
