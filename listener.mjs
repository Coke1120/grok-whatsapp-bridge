#!/usr/bin/env node
/**
 * Programmatic WhatsApp inbox listener — no LLM.
 * Polls bridge /messages, allowlist-filters, logs inbox.jsonl,
 * optional fixed ack via /send.
 *
 * With multi-account config, each account is polled on its own route
 * and the inbox row / webhook payload include `account`.
 */
import { appendFileSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAccountConfigs } from './accounts_config.js';
import { saveListenerState, webhookDestination, deliveryIdentity, retryableWebhookStatus, WAKE_RETRY_DELAYS, boundedInteger } from './listener_delivery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function listenerArtifactPaths(env = process.env, dir = __dirname) {
  function pick(key, filename) {
    const value = env?.[key];
    if (value == null || String(value).trim() === '') return path.join(dir, filename);
    return String(value);
  }
  return {
    inboxPath: pick('WHATSAPP_INBOX_PATH', 'inbox.jsonl'),
    statePath: pick('WHATSAPP_LISTENER_STATE_PATH', 'listener-state.json'),
    unreadFlagPath: pick('WHATSAPP_UNREAD_FLAG_PATH', 'unread.flag'),
  };
}

function parseAllowlist(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().replace(/^\+/, '').replace(/\s+/g, ''))
      .filter(Boolean),
  );
}

function digits(id) {
  return String(id || '').replace(/@.*/, '').replace(/:.*/, '').replace(/\D/g, '');
}

function eventAllowed(ev, allowset) {
  const candidates = [ev.senderId, ev.senderNumber, ev.chatId, ev.from]
    .flatMap((x) => (x ? [digits(x)] : []))
    .filter(Boolean);
  return candidates.some((d) => allowset.has(d));
}

function authorizationHeader(wakeAuth) {
  if (!wakeAuth) return '';
  if (wakeAuth.startsWith('Bearer ') || wakeAuth.startsWith('bearer ')) return wakeAuth;
  return `Bearer ${wakeAuth}`;
}

function chosen(accountValue, fallback) {
  return accountValue == null ? fallback : accountValue;
}

const TRANSIENT_HTTP = new Set([408, 503]);
const TRANSIENT_HEALTH = new Set(['disconnected', 'connecting', 'reconnecting']);
const HARD_HEALTH = new Set(['logged_out', 'paused']);

/**
 * Classify a `/messages` or `/health` payload.
 * Transient: HTTP 408/503, a "not connected" error, or health
 * `disconnected` / `connecting` / `reconnecting`.
 * Hard: other HTTP errors, `logged_out`, `paused`.
 */
export function classifyBridgeResponse(status, body) {
  if (TRANSIENT_HTTP.has(status)) {
    return { kind: 'transient', reason: `HTTP ${status}` };
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = String(body.error || '');
    const state = String(body.status || '');
    if (/not connected/i.test(error) || /not connected/i.test(state)) {
      return { kind: 'transient', reason: 'not-connected' };
    }
    if (TRANSIENT_HEALTH.has(state)) {
      return { kind: 'transient', reason: `status ${state}` };
    }
    if (HARD_HEALTH.has(state)) {
      return { kind: 'hard', reason: `status ${state}` };
    }
  }
  if (status >= 200 && status < 300) return { kind: 'ok', reason: '' };
  return { kind: 'hard', reason: `HTTP ${status}` };
}

export function createInboxListener(options) {
  const bridge = options.bridge || 'http://127.0.0.1:37100';
  const multi = !!options.multi;
  const accounts = options.accounts || [];
  const defaultAck = options.defaultAck ?? '';
  const defaultWakeUrl = options.defaultWakeUrl || '';
  const defaultWakeAuth = options.defaultWakeAuth || '';
  const pollMs = Number(options.pollMs || 2000);
  const inboxPath = options.inboxPath;
  const statePath = options.statePath;
  const unreadFlagPath = options.unreadFlagPath;
  const fetchImpl = options.fetch || globalThis.fetch;
  const log = options.log || ((line) => console.log(line));
  const warn = options.warn || ((line) => console.error(line));
  const pollRetryDelays = options.pollRetryDelays || [250, 500, 1000];
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const outages = new Map();
  const now = options.now || Date.now;
  const wakeTimeoutMs = boundedInteger(options.wakeTimeoutMs, 5000, 50, 30000);
  const wakeMaxAttempts = boundedInteger(options.wakeMaxAttempts, 5, 1, 10);
  const wakeRetryEnabled = options.wakeRetryEnabled === true;
  const wakeRetryDelays = options.wakeRetryDelays || WAKE_RETRY_DELAYS;
  const maxWakeAgeMs = options.maxWakeAgeMs ?? 60 * 60 * 1000;
  const outboxLimit = options.outboxLimit ?? 500;
  const maxWakesPerTick = options.maxWakesPerTick ?? 10;

  function loadState() {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { seen: [], acked: 0, processed: 0, pendingWakes: [] };
      // Resetting corrupt state would replay actions or lose pending deliveries.
      throw new Error('Listener state cannot be read safely; preserve it and restore a valid local backup.');
    }
  }

  const state = loadState();
  if (!state || !Array.isArray(state.seen) || state.seen.some((id) => typeof id !== 'string') || (!Number.isSafeInteger(state.acked) || state.acked < 0) ||
      (!Number.isSafeInteger(state.processed) || state.processed < 0) || (state.pendingWakes !== undefined && !Array.isArray(state.pendingWakes))) {
    throw new Error('Invalid listener state; refusing to reset delivery history.');
  }
  state.pendingWakes ??= [];
  if (state.uncertainAcks === undefined) state.uncertainAcks = [];
  if (!Array.isArray(state.uncertainAcks) || state.uncertainAcks.some((id) => typeof id !== 'string')) {
    throw new Error('Invalid acknowledgement history; refusing to reset it.');
  }
  for (const item of state.pendingWakes) {
    if (!item || typeof item.deliveryId !== 'string' || typeof item.account !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.destination) || !item.payload ||
        item.payload.deliveryId !== item.deliveryId || item.payload.source !== 'whatsapp-bridge-listener' ||
        typeof item.payload.chatId !== 'string' || typeof item.payload.body !== 'string' ||
        (item.payload.messageId !== null && typeof item.payload.messageId !== 'string') ||
        !['pending', 'in_flight', 'needs_review', 'failed', 'blocked', 'delivered'].includes(item.status) ||
        !Number.isSafeInteger(item.attempts) || item.attempts < 0 ||
        !Number.isFinite(item.createdAt) || !Number.isFinite(item.nextAttemptAt)) {
      throw new Error('Invalid webhook outbox; refusing to discard pending deliveries.');
    }
  }
  const seen = new Set(state.seen);

  function targets() {
    const source = multi ? accounts : [accounts[0] || { name: 'default', allowedUsers: '' }];
    return source.map((account) => {
      const name = account?.name || 'default';
      return {
        name,
        messagesUrl: multi ? `${bridge}/accounts/${name}/messages` : `${bridge}/messages`,
        sendUrl: multi ? `${bridge}/accounts/${name}/send` : `${bridge}/send`,
        allow: parseAllowlist(account?.allowedUsers || ''),
        ack: chosen(account?.programmaticAck, defaultAck),
        wakeUrl: String(chosen(account?.wakeWebhookUrl, defaultWakeUrl) || '').trim(),
        wakeAuth: String(chosen(account?.wakeWebhookAuth, defaultWakeAuth) || '').trim(),
      };
    });
  }

  function banner() {
    if (!multi) {
      const target = targets()[0];
      return `[listener] bridge=${bridge} allow=${[...target.allow].join(',')} ack=${target.ack ? 'on' : 'off'} wake=${target.wakeUrl ? 'on' : 'off'}`;
    }
    const names = accounts.map((account) => account.name).join(',');
    return `[listener] bridge=${bridge} accounts=${names} ack=per-account wake=per-account`;
  }

  function saveState() {
    // Retain process-local history until restart, as the legacy listener did.
    // Only the on-disk recent cache is bounded.
    for (const id of state.seen) seen.add(id);
    state.seen = state.seen.slice(-500);
    saveListenerState(statePath, state);
  }

  async function handleMessages(messages, target) {
    if (!Array.isArray(messages) || !messages.length) return;
    const acknowledgements = [];
    for (const ev of messages) {
      const messageId = ev.messageId || ev.id || null;
      const rawId = messageId || `${ev.chatId}:${ev.ts || ''}:${ev.body || ''}`;
      // Include chat and account so a message ID from another conversation does
      // not suppress this event. Keep legacy IDs during the migration window.
      const legacyId = multi ? `${target.name}:${rawId}` : rawId;
      const deliveryId = deliveryIdentity(target.name, ev.chatId, rawId);
      if (seen.has(deliveryId) || seen.has(legacyId) || state.uncertainAcks.includes(deliveryId) || state.pendingWakes.some((item) => item.deliveryId === deliveryId)) continue;
      const row = {
        ts: new Date(now()).toISOString(),
        messageId,
        deliveryId,
        allowed: eventAllowed(ev, target.allow),
        chatId: ev.chatId,
        senderId: ev.senderId,
        senderName: ev.senderName,
        body: ev.body,
        hasMedia: !!ev.hasMedia,
      };
      if (multi) row.account = target.name;
      appendFileSync(inboxPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      state.seen.push(deliveryId);
      if (row.allowed) {
        state.processed += 1;
        if (target.wakeUrl) {
          const payload = {
            source: 'whatsapp-bridge-listener',
            messageId,
            deliveryId,
            chatId: row.chatId,
            senderId: row.senderId,
            senderName: row.senderName,
            body: row.body,
            hasMedia: row.hasMedia,
            ts: row.ts,
          };
          if (multi) payload.account = target.name;
          state.pendingWakes.push({
            deliveryId, account: target.name, destination: webhookDestination(target),
            payload, createdAt: now(), nextAttemptAt: now(), attempts: 0, status: 'pending',
          });
        }
      }
      // Persist before any webhook or acknowledgement. A crash can duplicate an
      // inbox log row, but cannot send an unrecorded wake intentionally.
      saveState();
      log(`[listener] inbound ${JSON.stringify(row)}`);
      if (!row.allowed) { log('[listener] drop (not allowlisted)'); continue; }
      writeFileSync(unreadFlagPath, `${state.processed}\n`, { mode: 0o600 });

      if (target.ack && ev.chatId) acknowledgements.push({ chatId: ev.chatId, deliveryId });
    }
    // The whole destructively drained batch is persisted before the first
    // outbound request can block or the process can yield to network work.
    for (const { chatId, deliveryId } of acknowledgements) {
        // Keep unresolved acknowledgements outside the bounded seen cache.
        // A crash or timeout must not resend them after restart/cache eviction.
        state.uncertainAcks.push(deliveryId);
        saveState();
        try {
          const response = await fetchImpl(target.sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, message: target.ack }),
            signal: AbortSignal.timeout(wakeTimeoutMs), redirect: 'error',
          });
          // An uncertain acknowledgement is never retried automatically.
          if (response.ok) {
            state.acked += 1;
            state.uncertainAcks = state.uncertainAcks.filter((id) => id !== deliveryId);
            saveState();
          }
          log(`[listener] ack ${response.status} ${deliveryId}`);
        } catch {
          warn('[listener] ack outcome uncertain; not retried');
        }
    }
  }

  async function deliverWakes() {
    let count = 0;
    for (const item of state.pendingWakes) {
      if (item.status !== 'pending' || item.nextAttemptAt > now()) continue;
      if (count++ >= maxWakesPerTick) break;
      const target = targets().find((candidate) => candidate.name === item.account);
      // A configuration change must never redirect old mail to a new recipient.
      if (!target?.wakeUrl || webhookDestination(target) !== item.destination || !eventAllowed(item.payload, target.allow)) {
        item.status = 'blocked'; item.lastFailure = 'configuration_changed'; saveState();
        warn(`[listener] wake blocked ${item.deliveryId} (configuration_changed)`);
        continue;
      }
      if (item.attempts > 0 && !wakeRetryEnabled) {
        item.status = 'needs_review'; item.lastFailure = 'retry_disabled'; saveState();
        continue;
      }
      if (now() - item.createdAt >= maxWakeAgeMs || item.attempts >= wakeMaxAttempts) {
        item.status = 'failed'; item.lastFailure = 'retry_limit'; saveState();
        warn(`[listener] wake failed ${item.deliveryId} (retry_limit)`);
        continue;
      }
      // Commit in-flight state before transmitting. With retries disabled, a
      // process crash during the request requires review rather than replay.
      item.attempts += 1;
      item.status = 'in_flight';
      saveState();
      let failure;
      let retryable = false;
      try {
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': item.deliveryId };
        const authorization = authorizationHeader(target.wakeAuth);
        if (authorization) headers.Authorization = authorization;
        const response = await fetchImpl(target.wakeUrl, {
          method: 'POST', headers, body: JSON.stringify(item.payload),
          signal: AbortSignal.timeout(wakeTimeoutMs), redirect: 'manual',
        });
        if (response.ok) {
          item.status = 'delivered'; saveState();
          log(`[listener] wake ${response.status} ${item.deliveryId}`);
          continue;
        }
        failure = `http_${response.status}`;
        retryable = retryableWebhookStatus(response.status);
        // Bodies may contain secrets or untrusted data; neither read nor log.
        try { await response.body?.cancel(); } catch { /* Preserve the HTTP classification. */ }
      } catch {
        failure = 'network_or_timeout'; retryable = true;
      }
      item.lastFailure = failure;
      if (wakeRetryEnabled && retryable && item.attempts < wakeMaxAttempts) {
        item.status = 'pending';
        item.nextAttemptAt = now() + wakeRetryDelays[Math.min(item.attempts - 1, wakeRetryDelays.length - 1)];
      } else {
        item.status = retryable && !wakeRetryEnabled ? 'needs_review' : 'failed';
      }
      saveState();
      warn(`[listener] wake ${item.status} ${item.deliveryId} (${failure})`);
    }
    // Delivered payloads do not accumulate in state. Seen IDs remain bounded;
    // the separate inbox log retains observed messages with their stable IDs.
    const retained = state.pendingWakes.filter((item) => item.status !== 'delivered');
    if (retained.length !== state.pendingWakes.length) {
      state.pendingWakes = retained;
      saveState();
    }
  }

  // An in-flight request at crash time is ambiguous, never known-undelivered.
  for (const item of state.pendingWakes) {
    if (item.status === 'in_flight') {
      item.status = wakeRetryEnabled ? 'pending' : 'needs_review';
      item.lastFailure = 'interrupted_request';
    }
  }

  function outageLabel(target) {
    return multi ? ` ${target.name}` : '';
  }

  async function readPoll(url) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(wakeTimeoutMs), redirect: 'error' });
      const text = typeof response.text === 'function' ? await response.text() : '';
      let body = text;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      } else if (typeof response.json === 'function') {
        body = await response.json();
      }
      return { ...classifyBridgeResponse(response.status, body), body };
    } catch (err) {
      return { kind: 'transient', reason: err?.message || String(err), body: null };
    }
  }

  async function pollMessages(target) {
    const inOutage = outages.has(target.name);
    const attempts = inOutage ? 1 : (pollRetryDelays.length + 1);
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      last = await readPoll(target.messagesUrl);
      if (last.kind === 'ok') {
        if (outages.delete(target.name)) log(`[listener] poll resumed${outageLabel(target)}`);
        return last.body;
      }
      if (last.kind === 'hard') break;
      if (i < attempts - 1) await sleep(pollRetryDelays[i]);
    }
    const kind = last?.kind === 'hard' ? 'hard' : 'transient';
    const reason = last?.reason || 'poll failed';
    const prev = outages.get(target.name);
    if (!prev || prev.kind !== kind || prev.reason !== reason) {
      outages.set(target.name, { kind, reason });
      if (kind === 'transient') {
        warn(`[listener] reconnect window${outageLabel(target)} (${reason}); will keep polling`);
      } else {
        warn(`[listener] poll err${outageLabel(target)} ${reason}`);
      }
    }
    return null;
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await deliverWakes();
      for (const target of targets()) {
        if (state.pendingWakes.length + state.uncertainAcks.length >= outboxLimit) {
          warn('[listener] wake outbox full; intake paused until local review');
          break;
        }
        const messages = await pollMessages(target);
        if (messages == null) continue;
        await handleMessages(messages, target);
      }
      await deliverWakes();
      saveState();
    } finally {
      running = false;
    }
  }

  let timer = null;
  return {
    tick,
    banner,
    async start() {
      log(banner());
      timer = setInterval(() => {
        tick().catch((err) => warn(String(err?.message || err)));
      }, pollMs);
      await tick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const cfg = loadAccountConfigs({ env: process.env, cwd: process.cwd() });
  const paths = listenerArtifactPaths(process.env, __dirname);
  const listener = createInboxListener({
    bridge: process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:37100',
    multi: cfg.multi,
    accounts: cfg.accounts,
    defaultAck: process.env.WHATSAPP_PROGRAMMATIC_ACK ?? '',
    defaultWakeUrl: process.env.WHATSAPP_WAKE_WEBHOOK_URL || '',
    defaultWakeAuth: process.env.WHATSAPP_WAKE_WEBHOOK_AUTH || process.env.WHATSAPP_WAKE_AUTHORIZATION || '',
    pollMs: Number(process.env.WHATSAPP_POLL_MS || 2000),
    wakeTimeoutMs: process.env.WHATSAPP_WAKE_TIMEOUT_MS,
    wakeMaxAttempts: process.env.WHATSAPP_WAKE_MAX_ATTEMPTS,
    wakeRetryEnabled: process.env.WHATSAPP_WAKE_RETRY_ENABLED === '1',
    inboxPath: paths.inboxPath,
    statePath: paths.statePath,
    unreadFlagPath: paths.unreadFlagPath,
  });
  listener.start().catch((err) => {
    console.error(err);
  });
}
