import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationHistory, historyTimestamp, summarizeHistoryMessage } from '../conversation_history.js';

const A = '111@s.whatsapp.net';
const B = '222@lid';
const G = '123@g.us';
const msg = (chatId, messageId, timestamp = 100, body = messageId) => ({
  key: { remoteJid: chatId, id: messageId, fromMe: false }, messageTimestamp: timestamp,
  message: { conversation: body },
});
const store = (options = {}) => createConversationHistory({ account: 'default', canRead: () => true, ...options });

test('history stores only bounded safe summaries; rejects view-once, ephemeral and protocol content', () => {
  const base = msg(A, '1', 123, 'x'.repeat(8000));
  const summary = summarizeHistoryMessage(base);
  assert.equal(summary.body.length, 4096);
  assert.equal(summary.timestamp, 123);
  assert.equal(historyTimestamp({ low: 1 }), 0);
  assert.equal(historyTimestamp({ toString: () => '123' }), 123);
  assert.equal(historyTimestamp(-1), 0);
  assert.equal(historyTimestamp(Number.MAX_SAFE_INTEGER + 1), 0);
  for (const message of [
    { ephemeralMessage: { message: { conversation: 'private' } } },
    { viewOnceMessageV2: { message: { imageMessage: { caption: 'private' } } } },
    { documentWithCaptionMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'private' } } } } } },
    { documentWithCaptionMessage: { message: { ephemeralMessage: { message: { conversation: 'private' } } } } },
    { extendedTextMessage: { text: 'private', contextInfo: { expiration: 30 } } },
    { protocolMessage: { type: 0, key: base.key } },
    { pollUpdateMessage: { pollCreationMessageKey: base.key } },
  ]) assert.equal(summarizeHistoryMessage({ ...base, message }), null);
  const image = summarizeHistoryMessage({ ...base, message: { imageMessage: {
    caption: 'caption', url: 'secret-url', mediaKey: 'secret-key', jpegThumbnail: 'private-thumb',
    contextInfo: { quotedMessage: { conversation: 'quoted-private' } },
  } } });
  assert.equal(image.mediaType, 'image');
  assert.doesNotMatch(JSON.stringify(image), /secret|private|quotedMessage|url|mediaKey/);
});

test('paginated history is deterministic, nondestructive, isolated and rejects stale/tampered cursors', () => {
  const history = store();
  for (const [id, time] of [['a', 10], ['b', 20], ['c', 20]]) history.remember(msg(A, id, time));
  history.remember(msg(B, 'b', 30));
  let page = history.messages(A, { limit: 1 });
  assert.deepEqual(page.messages.map((m) => m.messageId), ['c']);
  assert.equal(page.complete, false);
  assert.equal(page.source, 'local-cache');
  assert.equal('key' in page.messages[0], false);
  const first = page.nextCursor;
  page = history.messages(A, { limit: 1, cursor: first });
  assert.deepEqual(page.messages.map((m) => m.messageId), ['b']);
  assert.equal(history.messages(A, { limit: 1 }).messages[0].messageId, 'c');
  assert.throws(() => history.messages(B, { cursor: first }), { status: 400 });
  assert.throws(() => history.listChats({ cursor: first }), { status: 400 });
  assert.throws(() => store({ account: 'other' }).messages(A, { cursor: first }), { status: 400 });
  assert.throws(() => history.messages(A, { cursor: first + 'x' }), { status: 400 });
  history.remember(msg(A, 'd', 40));
  assert.throws(() => history.messages(A, { cursor: first }), { status: 409 });
  for (const limit of [0, -1, 101, '1.0', '1e1', '01', [], {}]) {
    assert.throws(() => history.messages(A, { limit }), { status: 400 });
  }
});

test('chat pagination filters current permissions/groups before limiting and counts only cached rows', () => {
  const allowed = new Set([A, B, G]);
  const history = store({ canRead: (id) => allowed.has(id) });
  history.rememberChat({ id: A, name: 'Alice' });
  history.rememberChat({ id: '999@lid', name: 'denied-name' });
  history.remember(msg(A, 'a', 1)); history.remember(msg(B, 'b', 2)); history.remember(msg(G, 'g', 3));
  allowed.delete(B);
  const page = history.listChats({ limit: 1, groups: '0' });
  assert.deepEqual(page.chats.map((c) => c.chatId), [A]);
  assert.equal(page.chats[0].name, 'Alice');
  assert.equal(page.chats[0].messageCount, 1);
  assert.equal(page.nextCursor, null);
  assert.throws(() => history.messages(B), { status: 403 });
  assert.equal(history.oldest(B), null);
  assert.throws(() => history.listChats({ groups: 'yes' }), { status: 400 });
});

test('per-chat/global/chat-count retention is bounded and duplicate IDs are per chat', () => {
  const history = store({ limits: { chats: 2, messages: 3, perChat: 2 } });
  for (let i = 1; i <= 4; i++) history.remember(msg(A, 'a' + i, i));
  history.remember(msg(B, 'same', 8)); history.remember(msg(A, 'same', 9));
  history.flush();
  assert.deepEqual(history.messages(A).messages.map((m) => m.messageId), ['same', 'a4']);
  assert.equal(history.messages(B).messages[0].messageId, 'same');
  assert.equal(history.messages(A).truncated, true);
  history.rememberChat({ id: G, name: 'no messages' }); history.flush();
  assert.equal(history.listChats().chats.length, 2);
});

test('saved cache survives restart, is private and purges narrowed scopes on disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-history-'));
  const filePath = path.join(dir, 'conversation-history.json');
  try {
    let history = store({ filePath });
    history.remember(msg(A, 'a', 10)); history.remember(msg(B, 'b', 20));
    history.rememberChat({ id: A, name: 'Alice' }); history.flush();
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    const cursor = history.listChats({ limit: 1 }).nextCursor;
    history = store({ filePath, canRead: (id) => id === A });
    assert.deepEqual(history.messages(A).messages.map((m) => m.body), ['a']);
    assert.equal(history.listChats().chats[0].name, 'Alice');
    assert.equal(readFileSync(filePath, 'utf8').includes(B), false);
    assert.throws(() => history.listChats({ cursor }), { status: 400 });
    assert.throws(() => store({ filePath, account: 'other' }), /load conversation cache safely/);
    history.remove([{ remoteJid: A, id: 'a' }]); history.flush();
    assert.equal(store({ filePath }).messages(A).messages.length, 0);
    writeFileSync(filePath, '{broken');
    assert.throws(() => store({ filePath }), /load conversation cache safely/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache never follows a symlink to read or overwrite a different file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-history-symlink-'));
  try {
    const target = path.join(dir, 'target'); const filePath = path.join(dir, 'cache');
    writeFileSync(target, 'private'); symlinkSync(target, filePath);
    assert.throws(() => store({ filePath }), /load conversation cache safely/);
    assert.equal(readFileSync(target, 'utf8'), 'private');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serialized byte retention also bounds JSON escaping, rather than failing normal writes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-history-bytes-'));
  const filePath = path.join(dir, 'conversation-history.json');
  try {
    const history = store({ filePath });
    for (let i = 0; i < 600; i++) history.remember(msg(i % 2 ? A : B, String(i), 100 + i, '\u0001'.repeat(4096)));
    history.flush();
    assert.ok(statSync(filePath).size <= 12 * 1024 * 1024);
    assert.equal(history.listChats().truncated, true);
    assert.ok(history.listChats().chats.reduce((n, chat) => n + chat.messageCount, 0) < 600);
    assert.ok(store({ filePath }).messages(A).messages.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final whitespace cannot turn a group into an all-DM history record', () => {
  const history = store();
  for (const suffix of ['\n', '\r', '\u2028']) {
    history.rememberChat({ id: G + suffix, name: 'invalid' });
    history.remember(msg(G + suffix, 'bad'));
  }
  assert.deepEqual(history.listChats().chats, []);
});
