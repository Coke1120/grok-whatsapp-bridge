import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHAT_ID_RE } from './access_scopes.js';
import { getMessageContent } from './bridge_helpers.js';

const FILE_LIMIT = 12 * 1024 * 1024;
const DEFAULT_LIMITS = { chats: 256, messages: 2000, perChat: 500 };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const newestFirst = (a, b) => b.timestamp - a.timestamp || compare(b.messageId, a.messageId);
const error = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

export function historyTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** Deliberately exclude raw protobuf, quoted content, access keys and attachment URLs. */
export function summarizeHistoryMessage(msg) {
  const key = msg?.key;
  const chatId = key?.remoteJid;
  if (!CHAT_ID_RE.test(chatId || '') || typeof key?.id !== 'string' || !key.id || key.id.length > 256) return null;
  const raw = msg.message;
  // Do not turn disappearing or view-once messages into a durable archive.
  if (!raw || msg.messageStubType) return null;
  let envelope = raw;
  for (let depth = 0; depth < 9 && envelope; depth += 1) {
    if (envelope.ephemeralMessage || envelope.viewOnceMessage || envelope.viewOnceMessageV2 || envelope.viewOnceMessageV2Extension) return null;
    const nested = envelope.documentWithCaptionMessage?.message;
    if (!nested) break;
    if (depth === 8) return null;
    envelope = nested;
  }
  const content = getMessageContent(msg);
  if (content.protocolMessage || content.senderKeyDistributionMessage || content.pollUpdateMessage) return null;
  const context = Object.values(content).find((value) => value && typeof value === 'object' && value.contextInfo)?.contextInfo;
  if (context?.expiration || context?.ephemeralSettingTimestamp) return null;
  let body = content.conversation || content.extendedTextMessage?.text || '';
  let mediaType = '';
  for (const [field, kind] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio'],
    ['documentMessage', 'document'], ['stickerMessage', 'sticker']]) {
    if (content[field]) { mediaType = kind; body = content[field].caption || body; break; }
  }
  if (!body && !mediaType) return null;
  return {
    messageId: key.id, chatId, senderId: text(key.participant || (key.fromMe ? '' : chatId), 256),
    fromMe: key.fromMe === true, timestamp: historyTimestamp(msg.messageTimestamp),
    body: text(body, 4096), hasMedia: !!mediaType, mediaType,
    // Stored solely to anchor an explicitly requested provider history fetch.
    key: { remoteJid: chatId, id: key.id, fromMe: key.fromMe === true,
      ...(CHAT_ID_RE.test(key.participant || '') ? { participant: key.participant } : {}) },
  };
}

export function createConversationHistory({ account, filePath, canRead, limits = DEFAULT_LIMITS }) {
  const caps = { ...DEFAULT_LIMITS, ...limits };
  const chats = new Map();
  const secret = randomBytes(32);
  // Fixed-size, persistent body-free filters never evict historical/revoked
  // keys. False positives omit data/actions; they can never expose or replay it.
  const filters = { historical: null, deleted: null };
  const filterBytes = { historical: 1024 * 1024, deleted: 128 * 1024 };
  function validKey(key) { return permitted(key?.remoteJid) && typeof key?.id === 'string' && key.id.length > 0 && key.id.length <= 256; }
  function positions(kind, key) {
    const digest = createHash('sha256').update(JSON.stringify([account, key.remoteJid, key.id])).digest();
    return [0, 4, 8, 12].map((offset) => digest.readUInt32BE(offset) % (filterBytes[kind] * 8));
  }
  function marked(kind, key) {
    return !!filters[kind] && positions(kind, key).every((bit) => (filters[kind][bit >>> 3] & (1 << (bit & 7))) !== 0);
  }
  function mark(kind, key) {
    if (!filters[kind]) filters[kind] = Buffer.alloc(filterBytes[kind]);
    let updated = false;
    for (const bit of positions(kind, key)) {
      const mask = 1 << (bit & 7);
      if (!(filters[kind][bit >>> 3] & mask)) { filters[kind][bit >>> 3] |= mask; updated = true; }
    }
    if (updated) changed();
  }
  let revision = 0;
  let truncated = false;
  let dirty = false;

  function permitted(chatId) { return CHAT_ID_RE.test(chatId || '') && canRead(chatId); }
  function changed() { revision += 1; dirty = true; }
  function getChat(chatId) {
    if (!chats.has(chatId)) chats.set(chatId, { chatId, name: chatId.split('@')[0], messages: new Map() });
    return chats.get(chatId);
  }
  function sortedMessages(chat) { return [...chat.messages.values()].sort(newestFirst); }
  function chatTimestamp(chat) { return sortedMessages(chat)[0]?.timestamp || 0; }
  function prune() {
    for (const [chatId, chat] of chats) {
      if (!permitted(chatId)) { chats.delete(chatId); changed(); continue; }
      const entries = sortedMessages(chat);
      for (const message of entries.slice(caps.perChat)) { chat.messages.delete(message.messageId); truncated = true; changed(); }
    }
    const listed = [...chats.values()].sort((a, b) => chatTimestamp(b) - chatTimestamp(a) || compare(a.chatId, b.chatId));
    for (const chat of listed.slice(caps.chats)) { chats.delete(chat.chatId); truncated = true; changed(); }
    const all = [...chats.values()].flatMap((chat) => [...chat.messages.values()]).sort(newestFirst);
    for (const message of all.slice(caps.messages)) { chats.get(message.chatId)?.messages.delete(message.messageId); truncated = true; changed(); }
  }
  function rememberChat(raw) {
    if (!permitted(raw?.id)) return;
    const created = !chats.has(raw.id);
    const chat = getChat(raw.id);
    const name = text(raw.name || raw.subject, 256);
    if (name && name !== chat.name) { chat.name = name; changed(); }
    // Empty provider chat metadata is useful even before a message is cached.
    if (created) changed();
  }
  function remember(msg, { historical = false } = {}) {
    if (!validKey(msg?.key)) return;
    if (historical) mark('historical', msg.key);
    if (marked('deleted', msg.key)) return;
    const entry = summarizeHistoryMessage(msg);
    if (!entry) return;
    const chat = getChat(entry.chatId);
    const previous = chat.messages.get(entry.messageId);
    // Do not replace a provider-observed timestamp with an absent one.
    if (previous?.timestamp && !entry.timestamp) entry.timestamp = previous.timestamp;
    if (JSON.stringify(previous) !== JSON.stringify(entry)) { chat.messages.set(entry.messageId, entry); changed(); }
  }
  function remove(keys = [], allChatId) {
    if (allChatId && permitted(allChatId)) {
      for (const entry of chats.get(allChatId)?.messages.values() || []) mark('deleted', entry.key);
      if (chats.delete(allChatId)) changed();
    }
    for (const key of keys) {
      if (!validKey(key)) continue;
      mark('deleted', key);
      if (chats.get(key.remoteJid)?.messages.delete(key.id)) changed();
    }
  }
  function flush() {
    prune();
    if (!dirty || !filePath) return;
    const serialize = () => JSON.stringify({ version: 1, account, truncated, filters: Object.fromEntries(Object.entries(filters).map(([kind, value]) => [kind, value?.toString('base64') || null])), chats: [...chats.values()].map((chat) => ({
      chatId: chat.chatId, name: chat.name, messages: sortedMessages(chat),
    })) });
    let payload = serialize();
    let bytes = Buffer.byteLength(payload);
    if (bytes > FILE_LIMIT) {
      // UTF-8 and JSON escaping can exceed the character-based body limit.
      // Evict oldest summaries rather than letting normal input break writes.
      const oldest = [...chats.values()].flatMap((chat) => [...chat.messages.values()]).sort(newestFirst).reverse();
      for (const message of oldest) {
        chats.get(message.chatId).messages.delete(message.messageId);
        truncated = true; changed();
        bytes -= Buffer.byteLength(JSON.stringify(message));
        if (bytes < FILE_LIMIT - 1024) break;
      }
      payload = serialize();
      if (Buffer.byteLength(payload) > FILE_LIMIT) throw error(500, 'Conversation cache exceeds its storage bound.');
    }
    const temporary = path.join(path.dirname(filePath), `.conversation-history.${randomBytes(12).toString('hex')}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, payload); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, filePath);
      dirty = false;
    } catch {
      throw error(500, 'Could not persist conversation cache.');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
    }
  }

  if (filePath && existsSync(filePath)) {
    let saved;
    let fd;
    try {
      const info = lstatSync(filePath);
      if (!info.isFile() || info.size > FILE_LIMIT) throw new Error('Invalid cache file');
      fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      fchmodSync(fd, 0o600);
      saved = JSON.parse(readFileSync(fd, 'utf8'));
      if (saved.version !== 1 || saved.account !== account || !Array.isArray(saved.chats)) throw new Error('Invalid cache');
      truncated = saved.truncated === true;
      for (const kind of Object.keys(filters)) {
        const encoded = saved.filters?.[kind];
        if (encoded == null) continue;
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(filterBytes[kind] / 3) * 4) throw new Error('Invalid replay filter');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== filterBytes[kind] || bytes.toString('base64') !== encoded) throw new Error('Invalid replay filter');
        filters[kind] = bytes;
      }
      for (const chat of saved.chats.slice(0, caps.chats)) {
        if (!permitted(chat?.chatId) || !Array.isArray(chat.messages)) continue;
        rememberChat({ id: chat.chatId, name: chat.name });
        for (const entry of chat.messages.slice(0, caps.perChat)) {
          // Reconstruct through the same safe projector instead of trusting disk fields.
          if (entry?.chatId !== chat.chatId || entry?.key?.remoteJid !== chat.chatId || entry?.key?.id !== entry?.messageId) continue;
          remember({ key: entry.key, messageTimestamp: entry.timestamp,
            message: entry.hasMedia && ['image', 'video', 'audio', 'document', 'sticker'].includes(entry.mediaType)
              ? { [`${entry.mediaType}Message`]: { caption: text(entry.body, 4096) } }
              : { conversation: text(entry.body, 4096) } });
        }
      }
      // Rewrite on load so removed permissions also purge persisted records.
      changed(); flush();
    } catch {
      throw error(500, 'Could not load conversation cache safely.');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  function page(items, { limit = 20, cursor } = {}, kind) {
    if (typeof limit === 'string' && /^[1-9][0-9]{0,2}$/.test(limit)) limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, 'limit must be 1..100.');
    let offset = 0;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/.test(cursor)) throw error(400, 'Invalid history cursor.');
      try {
        const [data, signature, extra] = cursor.split('.');
        const expected = createHmac('sha256', secret).update(data).digest();
        const actual = Buffer.from(signature, 'base64url');
        if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const decoded = JSON.parse(Buffer.from(data, 'base64url').toString());
        if (decoded.account !== account || decoded.kind !== kind || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error();
        if (decoded.revision !== revision) throw error(409, 'Conversation cache changed; restart pagination.');
        offset = decoded.offset;
      } catch (err) { if (err.status === 409) throw err; throw error(400, 'Invalid history cursor.'); }
    }
    const entries = items.slice(offset, offset + limit);
    let nextCursor = null;
    if (offset + limit < items.length) {
      const data = Buffer.from(JSON.stringify({ account, kind, revision, offset: offset + limit })).toString('base64url');
      nextCursor = `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
    }
    return { entries, nextCursor, source: 'local-cache', complete: false, truncated };
  }
  return {
    remember, rememberChat, remove, flush,
    markHistoricalKey: (key) => { if (validKey(key)) mark('historical', key); },
    has: (chatId, messageId) => validKey({ remoteJid: chatId, id: messageId }) && (marked('historical', { remoteJid: chatId, id: messageId })
      || marked('deleted', { remoteJid: chatId, id: messageId }) || !!chats.get(chatId)?.messages.has(messageId)),
    listChats(options = {}) {
      prune();
      const groups = options.groups === undefined || options.groups === '1' || options.groups === true;
      if (options.groups !== undefined && !['0', '1', true, false].includes(options.groups)) throw error(400, 'groups must be 0 or 1.');
      const listed = [...chats.values()].filter((chat) => groups || !chat.chatId.endsWith('@g.us')).map((chat) => ({
        chatId: chat.chatId, name: chat.name, isGroup: chat.chatId.endsWith('@g.us'),
        lastMessageTimestamp: chatTimestamp(chat), messageCount: chat.messages.size,
      })).sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp || compare(a.chatId, b.chatId));
      const { entries, ...rest } = page(listed, options, `chats:${groups}`);
      return { chats: entries, ...rest };
    },
    messages(chatId, options = {}) {
      if (!permitted(chatId)) throw error(403, 'Chat is outside this account read scope.');
      prune();
      const listed = chats.has(chatId) ? sortedMessages(chats.get(chatId)) : [];
      const { entries, ...rest } = page(listed, options, `messages:${chatId}`);
      return { chatId, messages: entries.map(({ key, ...entry }) => entry), ...rest };
    },
    oldest(chatId) {
      if (!permitted(chatId)) return null;
      return chats.has(chatId) ? sortedMessages(chats.get(chatId)).filter((msg) => msg.timestamp).at(-1) || null : null;
    },
  };
}
