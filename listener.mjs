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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export function createInboxListener(options) {
  const bridge = options.bridge || 'http://127.0.0.1:3100';
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

  function loadState() {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      return { seen: [], acked: 0, processed: 0 };
    }
  }

  const state = loadState();
  const seen = new Set(state.seen || []);

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
    state.seen = (state.seen || []).slice(-500);
    writeFileSync(statePath, JSON.stringify(state));
  }

  async function handleMessages(messages, target) {
    if (!Array.isArray(messages) || !messages.length) return;
    for (const ev of messages) {
      const rawId = ev.id || ev.messageId || `${ev.chatId}:${ev.ts || ''}:${(ev.body || '').slice(0, 40)}`;
      const id = multi ? `${target.name}:${rawId}` : rawId;
      if (seen.has(id)) continue;
      seen.add(id);
      state.seen.push(id);

      const row = {
        ts: new Date().toISOString(),
        allowed: eventAllowed(ev, target.allow),
        chatId: ev.chatId,
        senderId: ev.senderId,
        senderName: ev.senderName,
        body: ev.body,
        hasMedia: !!ev.hasMedia,
      };
      if (multi) row.account = target.name;
      appendFileSync(inboxPath, `${JSON.stringify(row)}\n`);
      log(`[listener] inbound ${JSON.stringify(row)}`);

      if (!row.allowed) {
        log('[listener] drop (not allowlisted)');
        continue;
      }

      state.processed += 1;
      writeFileSync(unreadFlagPath, `${state.processed}\n`);

      if (target.wakeUrl) {
        try {
          const headers = { 'Content-Type': 'application/json' };
          const authorization = authorizationHeader(target.wakeAuth);
          if (authorization) headers.Authorization = authorization;
          const payload = {
            source: 'whatsapp-bridge-listener',
            chatId: ev.chatId,
            senderId: ev.senderId,
            senderName: ev.senderName,
            body: ev.body,
            hasMedia: !!ev.hasMedia,
            ts: row.ts,
          };
          if (multi) payload.account = target.name;
          const response = await fetchImpl(target.wakeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          });
          log(`[listener] wake ${response.status}`);
        } catch (err) {
          warn(`[listener] wake err ${err.message}`);
        }
      }

      if (target.ack && ev.chatId) {
        try {
          const response = await fetchImpl(target.sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: ev.chatId, message: target.ack }),
          });
          const body = await response.text();
          state.acked += 1;
          log(`[listener] ack ${response.status} ${typeof body === 'string' ? body.slice(0, 120) : ''}`);
        } catch (err) {
          warn(`[listener] ack err ${err.message}`);
        }
      }
    }
  }

  async function tick() {
    for (const target of targets()) {
      let messages;
      try {
        const response = await fetchImpl(target.messagesUrl);
        if (!response.ok) throw new Error(`messages ${response.status}`);
        messages = await response.json();
      } catch (err) {
        warn(`[listener] poll err ${err.message}`);
        continue;
      }
      await handleMessages(messages, target);
    }
    saveState();
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
  const listener = createInboxListener({
    bridge: process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:3100',
    multi: cfg.multi,
    accounts: cfg.accounts,
    defaultAck: process.env.WHATSAPP_PROGRAMMATIC_ACK ?? '',
    defaultWakeUrl: process.env.WHATSAPP_WAKE_WEBHOOK_URL || '',
    defaultWakeAuth: process.env.WHATSAPP_WAKE_WEBHOOK_AUTH || process.env.WHATSAPP_WAKE_AUTHORIZATION || '',
    pollMs: Number(process.env.WHATSAPP_POLL_MS || 2000),
    inboxPath: path.join(__dirname, 'inbox.jsonl'),
    statePath: path.join(__dirname, 'listener-state.json'),
    unreadFlagPath: path.join(__dirname, 'unread.flag'),
  });
  listener.start().catch((err) => {
    console.error(err);
  });
}
