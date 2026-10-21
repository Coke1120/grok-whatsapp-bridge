import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
  decryptPollVote,
  getKeyAuthor,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import qrcode from 'qrcode-terminal';
import { matchesAllowedSender, matchesAllowedUser, matchesInboundWhatsAppGroup, parseAllowedUsers } from './allowlist.js';
import { createOutboundIdTracker } from './outbound_ids.js';
import { classifyOwnerMessageGate } from './owner_message_gate.js';
import {
  addMentions,
  buildPollPayload,
  createPreQrCloseHint,
  createReconnectScheduler,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_CAP_MS,
  DEFAULT_RECONNECT_JITTER_RATIO,
  formatReconnectDelay,
  PRE_QR_EGRESS_HINT,
  buildLocationPayload,
  buildTextSendPayload,
  createBoundedMessageStore,
  createQuotedMediaCache,
  extractBridgeEvent,
  getMessageContent,
  inboundReadReceiptKeys,
  inferMediaType,
  mediaPayloadForFile,
  normalizeWhatsAppId,
  pollCreationMessageFromPayload,
  pollUpdateForAggregation,
  redactWhatsAppId,
  writeJsonLine,
} from './bridge_helpers.js';

const logger = pino({ level: 'warn' });
const MAX_QUEUE_SIZE = 100;

function detachSocket(socket) {
  if (!socket) return;
  try { socket.ev?.removeAllListeners?.(); } catch {}
  try { socket.end?.(); } catch {}
}

/**
 * One Baileys socket plus the HTTP operations for a single named account.
 * Sockets do not share a send queue: overlapping sends on one socket can
 * cross chats, but different accounts may send at the same time.
 */
export function createAccountRuntime(options) {
  const {
    name,
    sessionDir,
    mode = 'self-chat',
    multi = false,
    pairOnly = false,
    pairJson = false,
    dmPolicy = 'open',
    groupPolicy = 'pairing',
    allowedUsers: allowedUsersRaw = '',
    groupAllowedUsers: groupAllowedUsersRaw = '',
    replyPrefix = '',
    forwardOwnerMessages = false,
    sendReadReceipts = false,
    maxMessageLength = 4096,
    chunkDelayMs = 300,
    sendTimeoutMs = 60000,
    cacheDirs = {},
    debug = false,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    reconnectRetryMs,
    reconnectBaseMs = reconnectRetryMs ?? DEFAULT_RECONNECT_BASE_MS,
    reconnectCapMs = DEFAULT_RECONNECT_CAP_MS,
    reconnectJitterRatio = DEFAULT_RECONNECT_JITTER_RATIO,
    reconnectRandom = Math.random,
    deps = {},
  } = options;

  const useAuthState = deps.useMultiFileAuthState || useMultiFileAuthState;
  const createSocket = deps.makeWASocket || makeWASocket;
  const downloadMedia = deps.downloadMediaMessage || downloadMediaMessage;
  const getVersion = deps.getWAVersion || (async () => null);
  const renderQr = deps.renderQr || ((value) => {
    qrcode.generate(value, { small: true }, (code) => process.stdout.write(`${code}\n`));
  });
  const exitProcess = deps.exitProcess || ((code) => process.exit(code));
  const writeLog = options.log || ((text) => console.log(text));
  const writeWarn = options.warn || ((text) => console.warn(text));

  const allowedUsers = parseAllowedUsers(allowedUsersRaw);
  const groupAllowedUsers = parseAllowedUsers(groupAllowedUsersRaw);

  function log(text) {
    writeLog(multi ? `[${name}] ${text}` : text);
  }
  function warn(text) {
    writeWarn(multi ? `[${name}] ${text}` : text);
  }

  mkdirSync(sessionDir, { recursive: true });

  const messageQueue = [];
  const recentlySentIds = createOutboundIdTracker(512);
  const recentlyProcessedPollUpdates = createOutboundIdTracker(512);
  const messageStore = createBoundedMessageStore(512);
  const quotedMediaCache = createQuotedMediaCache(512);

  let sendQueue = Promise.resolve();
  function enqueueSend(fn) {
    const task = sendQueue.then(() => fn(), () => fn());
    sendQueue = task.catch(() => {});
    return task;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let sock = null;
  let connectionState = 'disconnected';
  let stopReconnect = false;
  let logoutRequested = false;
  let saveAllowed = true;
  let epoch = 0;
  const preQrCloseHint = createPreQrCloseHint();

  function emitPairEvent(event) {
    if (!pairJson) return;
    const payload = { ts: Date.now(), ...event };
    if (multi) payload.account = name;
    try { writeJsonLine(payload); } catch {}
  }

  function emitDebugEvent(payload) {
    if (!debug) return;
    try {
      writeJsonLine({ event: 'debug', ...(multi ? { account: name } : {}), ...payload });
    } catch {}
  }

  function pushEvent(event) {
    if (multi) event.account = name;
    messageQueue.push(event);
    if (messageQueue.length > MAX_QUEUE_SIZE) messageQueue.shift();
  }

  function sendWithTimeout(chatId, payload, sendOptions = {}, timeoutMs = sendTimeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sendMessage timed out after ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
    });
    return enqueueSend(() =>
      Promise.race([sock.sendMessage(chatId, payload, sendOptions), timeoutPromise])
        .finally(() => clearTimeout(timer)),
    );
  }

  function formatOutgoingMessage(message) {
    if (mode !== 'self-chat') return message;
    return replyPrefix ? `${replyPrefix}${message}` : message;
  }

  function splitLongMessage(message, limit = maxMessageLength) {
    const text = String(message || '');
    if (!text) return [];
    if (!Number.isFinite(limit) || limit < 1 || text.length <= limit) return [text];

    const chunks = [];
    let remaining = text;
    while (remaining.length > limit) {
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt < Math.floor(limit / 2)) {
        splitAt = remaining.lastIndexOf(' ', limit);
      }
      if (splitAt < 1) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  function rememberSentMessage(sent, payload) {
    if (!sent?.key?.id) return;
    if (sent.message) {
      messageStore.remember(sent);
      return;
    }
    const syntheticMessage = pollCreationMessageFromPayload(payload);
    if (syntheticMessage) messageStore.remember({ ...sent, message: syntheticMessage });
  }

  function rememberSentId(id) {
    recentlySentIds.remember(id);
  }

  function trackSentMessageId(sent) {
    rememberSentId(sent?.key?.id);
  }

  function notConnected(error) {
    return { status: 503, body: { error } };
  }

  function normalizePollUpdateOptions(aggregation, pollUpdateMessage) {
    const selected = [];
    for (const option of aggregation || []) {
      if ((option.voters || []).length > 0 && option.name && option.name !== 'Unknown') {
        selected.push(option.name);
      }
    }
    if (selected.length > 0) return selected;
    const raw = pollUpdateMessage?.vote?.selectedOptions || [];
    return raw.map((option) => String(option)).filter(Boolean);
  }

  function pollAggregationSummary(aggregation) {
    return (aggregation || []).map((option) => ({
      name: option?.name || '',
      voterCount: (option?.voters || []).length,
    }));
  }

  function logPollUpdateDiagnostic({ sourcePath, pollId, pollCreation, pollUpdates, selectedOptions, aggregation }) {
    const firstUpdate = pollUpdates?.[0] || {};
    try {
      writeJsonLine({
        event: 'poll_update_decode',
        ...(multi ? { account: name } : {}),
        sourcePath,
        pollId: pollId || '',
        pollCreationFound: !!pollCreation,
        updateKeys: Object.keys(firstUpdate),
        hasVote: !!firstUpdate.vote,
        selectedOptionsLength: selectedOptions?.length || 0,
        aggregation: pollAggregationSummary(aggregation),
      });
    } catch {}
  }

  function enqueuePollUpdateEvent({ key, update, selectedOptions, aggregation }) {
    const chatId = normalizeWhatsAppId(key?.remoteJid || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.remoteJid || '');
    const senderId = normalizeWhatsAppId(
      key?.participant
      || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.participant
      || chatId,
    );
    const pollId = key?.id
      || update?.pollUpdates?.[0]?.pollCreationMessageKey?.id
      || update?.pollUpdates?.[0]?.pollUpdateMessageKey?.id
      || '';
    if (!pollId || !recentlySentIds.has(pollId)) {
      if (debug) {
        try { writeJsonLine({ event: 'ignored', ...(multi ? { account: name } : {}), reason: 'foreign_poll_update', pollId }); } catch {}
      }
      return;
    }
    const chosenText = selectedOptions.length ? selectedOptions.join(', ') : `[Poll update${pollId ? `: ${pollId}` : ''}]`;
    const dedupeId = `poll:${pollId}:${senderId}:${selectedOptions.join('|')}`;
    if (recentlyProcessedPollUpdates.has(dedupeId)) return;
    recentlyProcessedPollUpdates.remember(dedupeId);
    pushEvent({
      messageId: `${pollId || 'poll'}:update:${Date.now()}`,
      chatId,
      senderId,
      senderName: senderId.replace(/@.*/, ''),
      chatName: chatId.replace(/@.*/, ''),
      isGroup: chatId.endsWith('@g.us'),
      body: chosenText,
      hasMedia: false,
      mediaType: 'poll_update',
      mime: '',
      fileName: '',
      nativeType: 'pollUpdateMessage',
      nativeMetadata: { pollUpdate: { pollId, selectedOptions, aggregation } },
      mediaUrls: [],
      mentionedIds: [],
      quotedMessageId: pollId,
      quotedParticipant: '',
      quotedRemoteJid: chatId,
      quotedText: '',
      hasQuotedMessage: !!pollId,
      botIds: [],
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  function bindSocket(created, saveCreds) {
    created.ev.on('creds.update', () => {
      if (sock !== created || !saveAllowed) return;
      saveCreds();
    });

    created.ev.on('connection.update', (update) => {
      if (sock !== created) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        preQrCloseHint.noteQr();
        if (pairJson) {
          emitPairEvent({ event: 'qr', qr });
        } else {
          log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
          renderQr(qr);
          log('\nWaiting for scan...\n');
        }
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        sock = null;
        if (reason === DisconnectReason.loggedOut) {
          connectionState = 'logged_out';
          stopReconnect = true;
          scheduleReconnect.cancel();
          emitPairEvent({ event: 'error', error: 'logged_out', reason });
          if (!pairJson) log('❌ Logged out. Delete session and restart to re-authenticate.');
          if (!multi && !logoutRequested) exitProcess(1);
          return;
        }
        if (stopReconnect) {
          if (connectionState !== 'logged_out') connectionState = 'paused';
          return;
        }
        connectionState = 'disconnected';
        emitPairEvent({ event: 'disconnected', reason });
        const restartRequested = reason === 515;
        const delayMs = scheduleReconnect.afterClose({ restartRequested });
        if (!pairJson) {
          if (restartRequested) log('↻ WhatsApp requested restart (code 515). Reconnecting...');
          else log(`⚠️  Connection closed (reason: ${reason}). Reconnecting in ${formatReconnectDelay(delayMs)}...`);
        }
        if (preQrCloseHint.consume(reason) && !pairJson) log(PRE_QR_EGRESS_HINT);
        return;
      }

      if (connection === 'open') {
        preQrCloseHint.noteOpen();
        scheduleReconnect.noteOpen();
        connectionState = 'connected';
        const connectedUser = created.user
          ? { id: created.user.id || null, name: created.user.name || created.user.verifiedName || null }
          : null;
        emitPairEvent({ event: 'connected', user: connectedUser });
        if (!pairJson) log('✅ WhatsApp connected!');
        if (pairOnly) {
          if (!pairJson) log('✅ Pairing complete. Credentials saved.');
          setTimeoutFn(() => exitProcess(0), 2000);
        }
      }
    });

    created.ev.on('messages.update', async (updates) => {
      if (sock !== created) return;
      for (const { key, update } of updates || []) {
        if (sock !== created) return;
        if (!update?.pollUpdates) continue;
        const pollCreationId = key?.id || update.pollUpdates?.[0]?.pollCreationMessageKey?.id;
        const pollCreation = messageStore.get(pollCreationId);
        let aggregation = [];
        let pollUpdates = update.pollUpdates;
        try {
          if (pollCreation) {
            const meId = jidNormalizedUser(created.user?.id || 'me');
            pollUpdates = update.pollUpdates.map((pollUpdate) => (
              pollUpdateForAggregation({
                pollUpdateMessage: pollUpdate,
                pollUpdateMessageKey: pollUpdate.pollUpdateMessageKey,
                pollCreation,
                decryptPollVote,
                getKeyAuthor,
                meId,
                pollCreatorJids: [
                  jidNormalizedUser(created.user?.lid || ''),
                  jidNormalizedUser(created.user?.id || ''),
                  getKeyAuthor(pollUpdate.pollCreationMessageKey || key, jidNormalizedUser(created.user?.lid || '')),
                  getKeyAuthor(pollUpdate.pollCreationMessageKey || key, jidNormalizedUser(created.user?.id || '')),
                ],
                voterJids: [
                  normalizeWhatsAppId(pollUpdate.pollUpdateMessageKey?.participant || ''),
                  normalizeWhatsAppId(pollUpdate.pollUpdateMessageKey?.remoteJid || key?.remoteJid || ''),
                ],
              }) || pollUpdate
            ));
            aggregation = getAggregateVotesInPollMessage({
              message: pollCreation.message,
              pollUpdates,
            });
          }
        } catch (err) {
          warn(`[bridge] failed to aggregate poll update: ${err.message}`);
        }
        const selectedOptions = normalizePollUpdateOptions(aggregation, pollUpdates?.[0]);
        logPollUpdateDiagnostic({
          sourcePath: 'messages.update',
          pollId: pollCreationId,
          pollCreation,
          pollUpdates,
          selectedOptions,
          aggregation,
        });
        enqueuePollUpdateEvent({ key, update: { ...update, pollUpdates }, selectedOptions, aggregation });
      }
    });

    created.ev.on('messages.upsert', async ({ messages, type }) => {
      if (sock !== created) return;
      if (type !== 'notify' && type !== 'append') return;

      const botIds = Array.from(new Set([
        normalizeWhatsAppId(created.user?.id),
        normalizeWhatsAppId(created.user?.lid),
      ].filter(Boolean)));

      for (const msg of messages) {
        if (sock !== created) return;
        if (!msg.message) continue;

        const chatId = msg.key.remoteJid;
        const senderId = msg.key.participant || chatId;
        const senderAltId = normalizeWhatsAppId(msg.key.participantAlt || msg.key.remoteJidAlt || '');
        const resolvedSenderId = senderAltId.endsWith('@s.whatsapp.net') ? senderAltId : senderId;
        const isGroup = chatId.endsWith('@g.us');
        const senderNumber = resolvedSenderId.replace(/@.*/, '');
        emitDebugEvent({
          stage: 'upsert',
          type,
          fromMe: !!msg.key.fromMe,
          chatId: redactWhatsAppId(chatId),
          senderId: redactWhatsAppId(senderId),
          messageKeys: Object.keys(msg.message || {}),
        });

        let fromOwner = false;
        if (msg.key.fromMe) {
          if (isGroup || chatId.includes('status')) {
            emitDebugEvent({
              stage: 'ignored',
              reason: isGroup ? 'from_me_group' : 'from_me_status',
              chatId: redactWhatsAppId(chatId),
            });
            continue;
          }

          if (mode === 'bot') {
            const decision = classifyOwnerMessageGate({
              fromMe: true,
              fromOwnerEnabled: forwardOwnerMessages,
              recentlySent: recentlySentIds,
              allowlistMatches: (id) => matchesAllowedUser(id, allowedUsers, sessionDir),
              messageId: msg.key.id,
              chatId,
            });
            if (decision.action === 'drop_echo') continue;
            if (decision.action === 'drop_disabled') continue;
            if (decision.action === 'drop_allowlist') {
              try {
                writeJsonLine({
                  event: 'ignored',
                  ...(multi ? { account: name } : {}),
                  reason: 'allowlist_mismatch_owner_chat',
                  chatId,
                  senderId,
                });
              } catch {}
              continue;
            }
            fromOwner = true;
          } else {
            const myNumber = (created.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
            const myLid = (created.user?.lid || '').replace(/:.*@/, '@').replace(/@.*/, '');
            const chatNumber = chatId.replace(/@.*/, '');
            const isSelfChat = (myNumber && chatNumber === myNumber) || (myLid && chatNumber === myLid);
            emitDebugEvent({
              stage: 'self_chat_check',
              matched: !!isSelfChat,
              chatId: redactWhatsAppId(chatId),
              accountId: redactWhatsAppId(created.user?.id),
              accountLid: redactWhatsAppId(created.user?.lid),
            });
            if (!isSelfChat) {
              emitDebugEvent({
                stage: 'ignored',
                reason: 'self_chat_mismatch',
                chatId: redactWhatsAppId(chatId),
                senderId: redactWhatsAppId(senderId),
              });
              continue;
            }
          }
        }

        if (!msg.key.fromMe) {
          if (mode === 'self-chat') {
            try {
              writeJsonLine({
                event: 'ignored',
                ...(multi ? { account: name } : {}),
                reason: 'self_chat_mode_rejects_non_self',
                chatId,
                senderId,
              });
            } catch {}
            continue;
          }
          const intakeAllowed = isGroup
            ? matchesInboundWhatsAppGroup({
              chatId,
              groupPolicy,
              groupAllowedUsers,
              sessionDir,
            })
            : dmPolicy === 'pairing'
              || matchesAllowedSender(senderId, senderAltId, allowedUsers, sessionDir);
          if (!intakeAllowed) {
            try {
              writeJsonLine({
                event: 'ignored',
                ...(multi ? { account: name } : {}),
                reason: isGroup ? 'group_policy_rejected' : 'allowlist_mismatch',
                chatId,
                senderId,
                senderAltId,
              });
            } catch {}
            continue;
          }
        }

        const messageContent = getMessageContent(msg);
        if (messageContent.pollUpdateMessage) {
          const pollUpdateMessage = messageContent.pollUpdateMessage;
          const pollKey = pollUpdateMessage.pollCreationMessageKey || {
            id: pollUpdateMessage.key?.id || msg.key.id,
            remoteJid: chatId,
            participant: senderId,
          };
          const pollCreation = messageStore.get(pollKey.id);
          let aggregation = [];
          let pollUpdates = [pollUpdateMessage];
          try {
            if (pollCreation) {
              const meId = jidNormalizedUser(created.user?.id || 'me');
              const pollUpdate = pollUpdateForAggregation({
                pollUpdateMessage,
                pollUpdateMessageKey: msg.key,
                pollCreation,
                decryptPollVote,
                getKeyAuthor,
                meId,
                pollCreatorJids: [
                  jidNormalizedUser(created.user?.lid || ''),
                  jidNormalizedUser(created.user?.id || ''),
                  getKeyAuthor(pollUpdateMessage.pollCreationMessageKey || pollKey, jidNormalizedUser(created.user?.lid || '')),
                  getKeyAuthor(pollUpdateMessage.pollCreationMessageKey || pollKey, jidNormalizedUser(created.user?.id || '')),
                ],
                voterJids: [
                  normalizeWhatsAppId(msg.key?.participant || ''),
                  normalizeWhatsAppId(msg.key?.remoteJid || chatId || ''),
                  normalizeWhatsAppId(senderId || ''),
                ],
              });
              if (pollUpdate) pollUpdates = [pollUpdate];
              aggregation = getAggregateVotesInPollMessage({
                message: pollCreation.message,
                pollUpdates,
              });
            }
          } catch (err) {
            warn(`[bridge] failed to aggregate poll upsert: ${err.message}`);
          }
          const selectedOptions = normalizePollUpdateOptions(aggregation, pollUpdates[0]);
          logPollUpdateDiagnostic({
            sourcePath: 'messages.upsert',
            pollId: pollKey.id,
            pollCreation,
            pollUpdates,
            selectedOptions,
            aggregation,
          });
          enqueuePollUpdateEvent({
            key: { ...pollKey, remoteJid: pollKey.remoteJid || chatId, participant: pollKey.participant || senderId },
            update: { pollUpdates },
            selectedOptions,
            aggregation,
          });
          continue;
        }

        const event = await extractBridgeEvent({
          msg,
          chatId,
          senderId: resolvedSenderId,
          senderNumber,
          botIds,
          isGroup,
          downloadMedia: async (mediaMsg) => downloadMedia(mediaMsg, 'buffer', {}, {
            logger,
            reuploadRequest: created.updateMediaMessage,
          }),
          cacheDirs: {
            image: cacheDirs.image,
            document: cacheDirs.document,
            audio: cacheDirs.audio,
          },
          lookupQuotedMedia: (quotedChatId, quotedMessageId) => quotedMediaCache.get(quotedChatId, quotedMessageId),
        });
        if (sock !== created) return;
        event.fromOwner = fromOwner;

        if (msg.key.fromMe && ((replyPrefix && event.body.startsWith(replyPrefix)) || recentlySentIds.has(msg.key.id))) {
          if (debug) {
            emitDebugEvent({
              stage: 'ignored',
              reason: 'agent_echo',
              chatId: redactWhatsAppId(chatId),
              messageId: msg.key.id,
            });
          }
          continue;
        }

        if (!event.body && !event.hasMedia && !event.quotedMediaUrls?.length) {
          emitDebugEvent({
            stage: 'ignored',
            reason: 'empty',
            chatId: redactWhatsAppId(chatId),
            messageKeys: Object.keys(msg.message || {}),
          });
          continue;
        }

        messageStore.remember(msg);
        quotedMediaCache.remember(chatId, msg.key.id, {
          body: event.body,
          hasMedia: event.hasMedia,
          mediaType: event.mediaType,
          mediaUrls: event.mediaUrls,
        });
        pushEvent(event);
        emitDebugEvent({
          stage: 'queued',
          chatId: redactWhatsAppId(chatId),
          senderId: redactWhatsAppId(senderId),
          fromOwner: !!fromOwner,
          bodyLength: event.body.length,
          hasMedia: event.hasMedia,
          mediaType: event.mediaType,
          queueLength: messageQueue.length,
        });
      }
    });
  }

  async function startSocket() {
    const myEpoch = ++epoch;
    if (stopReconnect) return;
    const previous = sock;
    sock = null;
    detachSocket(previous);

    const { state, saveCreds } = await useAuthState(sessionDir);
    if (stopReconnect || myEpoch !== epoch) return;
    preQrCloseHint.noteSocketAttempt(state?.creds);
    const version = await getVersion();
    if (stopReconnect || myEpoch !== epoch) return;

    const created = createSocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Hermes Agent', 'Chrome', '120.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => ({ conversation: '' }),
    });
    if (stopReconnect || myEpoch !== epoch) {
      detachSocket(created);
      return;
    }
    saveAllowed = true;
    sock = created;
    bindSocket(created, saveCreds);
  }

  const scheduleReconnect = createReconnectScheduler(() => startSocket(), {
    baseMs: reconnectBaseMs,
    capMs: reconnectCapMs,
    jitterRatio: reconnectJitterRatio,
    random: reconnectRandom,
    log,
    setTimeoutFn,
    clearTimeoutFn,
  });

  async function start() {
    if (pairOnly) {
      try {
        await startSocket();
      } catch (err) {
        emitPairEvent({ event: 'error', error: err?.message || String(err) });
        if (!pairJson) log(String(err?.stack || err?.message || err));
        exitProcess(1);
      }
      return;
    }
    scheduleReconnect(0);
  }

  async function pause() {
    stopReconnect = true;
    saveAllowed = false;
    epoch += 1;
    scheduleReconnect.cancel();
    connectionState = 'paused';
    const current = sock;
    sock = null;
    detachSocket(current);
    return { status: 200, body: { success: true, account: name, status: 'paused' } };
  }

  function resume() {
    logoutRequested = false;
    stopReconnect = false;
    saveAllowed = true;
    connectionState = 'disconnected';
    scheduleReconnect.enable();
    scheduleReconnect(0);
    return { status: 200, body: { success: true, account: name, status: connectionState } };
  }

  async function logout() {
    logoutRequested = true;
    stopReconnect = true;
    saveAllowed = false;
    preQrCloseHint.resetAfterLogout();
    epoch += 1;
    scheduleReconnect.cancel();
    connectionState = 'logged_out';
    const current = sock;
    sock = null;
    try {
      if (typeof current?.logout === 'function') await current.logout();
      else detachSocket(current);
    } catch (err) {
      detachSocket(current);
      return { status: 500, body: { error: err.message } };
    }
    if (!multi) setTimeoutFn(() => exitProcess(1), 50);
    return { status: 200, body: { success: true, account: name, status: 'logged_out' } };
  }

  function healthSnapshot() {
    return {
      name,
      status: connectionState,
      session: path.resolve(sessionDir),
      queueLength: messageQueue.length,
      mode,
      sendReadReceipts: !!sendReadReceipts,
      linkedUser: redactWhatsAppId(sock?.user?.id || ''),
    };
  }

  function drainMessages() {
    return messageQueue.splice(0, messageQueue.length);
  }

  async function send(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected to WhatsApp');
    const { chatId, message, replyTo, mentions } = body || {};
    if (!chatId || !message) {
      return { status: 400, body: { error: 'chatId and message are required' } };
    }
    try {
      const chunks = splitLongMessage(formatOutgoingMessage(message));
      const messageIds = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const { content: payload, options: sendOptions } = buildTextSendPayload(chunks[i], {
          chatId,
          replyTo: i === 0 ? replyTo : undefined,
          mentions: i === 0 ? mentions : undefined,
          messageStore,
        });
        const sent = await sendWithTimeout(chatId, payload, sendOptions);
        trackSentMessageId(sent);
        messageStore.remember(sent);
        if (sent?.key?.id) messageIds.push(sent.key.id);
        if (chunks.length > 1 && i < chunks.length - 1) await sleep(chunkDelayMs);
      }
      return {
        status: 200,
        body: { success: true, messageId: messageIds[messageIds.length - 1], messageIds },
      };
    } catch (err) {
      return { status: 500, body: { error: err.message } };
    }
  }

  async function edit(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected to WhatsApp');
    const { chatId, messageId, message } = body || {};
    if (!chatId || !messageId || !message) {
      return { status: 400, body: { error: 'chatId, messageId, and message are required' } };
    }
    try {
      const key = { id: messageId, fromMe: true, remoteJid: chatId };
      const chunks = splitLongMessage(formatOutgoingMessage(message));
      const messageIds = [];
      await sendWithTimeout(chatId, { text: chunks[0], edit: key });
      if (chunks.length > 1) {
        for (let i = 1; i < chunks.length; i += 1) {
          const sent = await sendWithTimeout(chatId, { text: chunks[i] });
          trackSentMessageId(sent);
          if (sent?.key?.id) messageIds.push(sent.key.id);
          if (i < chunks.length - 1) await sleep(chunkDelayMs);
        }
      }
      return { status: 200, body: { success: true, messageIds } };
    } catch (err) {
      return { status: 500, body: { error: err.message } };
    }
  }

  async function sendMedia(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected to WhatsApp');
    const { chatId, filePath, mediaType, caption, fileName, mentions } = body || {};
    if (!chatId || !filePath) {
      return { status: 400, body: { error: 'chatId and filePath are required' } };
    }
    try {
      if (!existsSync(filePath)) {
        return { status: 404, body: { error: `File not found: ${filePath}` } };
      }
      const buffer = readFileSync(filePath);
      const ext = filePath.toLowerCase().split('.').pop();
      const type = mediaType || inferMediaType(ext);
      let msgPayload;

      switch (type) {
        case 'image':
          if (ext === 'gif') {
            let tmpGifMp4 = null;
            try {
              tmpGifMp4 = path.join(tmpdir(), `hermes_gif_${randomBytes(6).toString('hex')}.mp4`);
              execFileSync(
                'ffmpeg',
                ['-y', '-i', filePath, '-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', tmpGifMp4],
                { timeout: 30000, stdio: 'pipe' },
              );
              msgPayload = {
                video: readFileSync(tmpGifMp4),
                caption: caption || undefined,
                mimetype: 'video/mp4',
                gifPlayback: true,
              };
            } catch (gifErr) {
              warn(`[bridge] gif conversion failed, sending as image/gif: ${gifErr.message}`);
              msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: type, caption, fileName });
            } finally {
              try { if (tmpGifMp4 && existsSync(tmpGifMp4)) unlinkSync(tmpGifMp4); } catch {}
            }
          } else {
            msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: type, caption, fileName });
          }
          break;
        case 'video':
          msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: type, caption, fileName });
          break;
        case 'audio': {
          let audioBuffer = buffer;
          let audioExt = ext;
          const needsConversion = !['ogg', 'opus'].includes(ext);
          let tmpPath = null;
          if (needsConversion) {
            tmpPath = path.join(tmpdir(), `hermes_voice_${randomBytes(6).toString('hex')}.ogg`);
            try {
              execFileSync(
                'ffmpeg',
                ['-y', '-i', filePath, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', tmpPath],
                { timeout: 30000, stdio: 'pipe' },
              );
              audioBuffer = readFileSync(tmpPath);
              audioExt = 'ogg';
            } catch (convErr) {
              warn(`[bridge] ffmpeg conversion failed, sending as file attachment: ${convErr.message}`);
            } finally {
              try { if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
            }
          }
          const audioMime = (audioExt === 'ogg' || audioExt === 'opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
          msgPayload = { audio: audioBuffer, mimetype: audioMime, ptt: audioExt === 'ogg' || audioExt === 'opus' };
          break;
        }
        case 'document':
        default:
          msgPayload = mediaPayloadForFile({ buffer, filePath, mediaType: 'document', caption, fileName });
          break;
      }

      msgPayload = addMentions(msgPayload, mentions);
      const sent = await sendWithTimeout(chatId, msgPayload);
      trackSentMessageId(sent);
      messageStore.remember(sent);
      return { status: 200, body: { success: true, messageId: sent?.key?.id } };
    } catch (err) {
      return { status: 500, body: { error: err.message } };
    }
  }

  async function sendPoll(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected to WhatsApp');
    const { chatId, question, options: pollOptions, selectableCount } = body || {};
    if (!chatId || !question || !Array.isArray(pollOptions)) {
      return { status: 400, body: { error: 'chatId, question, and options are required' } };
    }
    try {
      const payload = buildPollPayload({ question, options: pollOptions, selectableCount });
      const sent = await sendWithTimeout(chatId, payload);
      trackSentMessageId(sent);
      rememberSentMessage(sent, payload);
      return { status: 200, body: { success: true, messageId: sent?.key?.id } };
    } catch (err) {
      return { status: 400, body: { error: err.message } };
    }
  }

  async function sendLocation(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected to WhatsApp');
    const { chatId, latitude, longitude, name: placeName, address } = body || {};
    if (!chatId || latitude === undefined || longitude === undefined) {
      return { status: 400, body: { error: 'chatId, latitude, and longitude are required' } };
    }
    try {
      const payload = buildLocationPayload({ latitude, longitude, name: placeName, address });
      const sent = await sendWithTimeout(chatId, payload);
      trackSentMessageId(sent);
      messageStore.remember(sent);
      return { status: 200, body: { success: true, messageId: sent?.key?.id } };
    } catch (err) {
      return { status: 400, body: { error: err.message } };
    }
  }

  async function typing(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected');
    const { chatId } = body || {};
    if (!chatId) return { status: 400, body: { error: 'chatId required' } };
    try {
      await sock.sendPresenceUpdate('composing', chatId);
      return { status: 200, body: { success: true } };
    } catch {
      return { status: 200, body: { success: false } };
    }
  }

  async function markRead(body) {
    if (!sock || connectionState !== 'connected') return notConnected('Not connected');
    const receiptKeys = inboundReadReceiptKeys({
      key: body?.key,
      enabled: sendReadReceipts,
    });
    if (receiptKeys.length === 0) return { status: 200, body: { success: true, marked: false } };
    try {
      await sock.readMessages(receiptKeys);
      return { status: 200, body: { success: true, marked: true } };
    } catch (err) {
      warn(`[bridge] failed to send read receipt: ${err.message}`);
      return { status: 500, body: { error: 'Failed to send read receipt' } };
    }
  }

  async function chatInfo(chatId) {
    const isGroup = String(chatId || '').endsWith('@g.us');
    if (isGroup && sock) {
      try {
        const metadata = await sock.groupMetadata(chatId);
        return {
          status: 200,
          body: {
            name: metadata.subject,
            isGroup: true,
            participants: metadata.participants.map((participant) => participant.id),
          },
        };
      } catch {}
    }
    return {
      status: 200,
      body: {
        name: String(chatId || '').replace(/@.*/, ''),
        isGroup,
        participants: [],
      },
    };
  }

  return {
    name,
    start,
    pause,
    resume,
    logout,
    getStatus: () => connectionState,
    healthSnapshot,
    drainMessages,
    send,
    edit,
    sendMedia,
    sendPoll,
    sendLocation,
    typing,
    markRead,
    chatInfo,
  };
}
