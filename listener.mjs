#!/usr/bin/env node
/**
 * Programmatic WhatsApp inbox listener — no LLM.
 * Polls bridge /messages, allowlist-filters, logs inbox.jsonl,
 * optional fixed ack via /send.
 */
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:3100';
const ALLOWED = new Set(
  String(process.env.WHATSAPP_ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim().replace(/^\+/, '').replace(/\s+/g, ''))
    .filter(Boolean),
);
const ACK = process.env.WHATSAPP_PROGRAMMATIC_ACK ?? '';
const WAKE_URL = (process.env.WHATSAPP_WAKE_WEBHOOK_URL || '').trim();
const WAKE_AUTH = (process.env.WHATSAPP_WAKE_WEBHOOK_AUTH || process.env.WHATSAPP_WAKE_AUTHORIZATION || '').trim();
const POLL_MS = Number(process.env.WHATSAPP_POLL_MS || 2000);
const INBOX = path.join(__dirname, 'inbox.jsonl');
const STATE = path.join(__dirname, 'listener-state.json');

function digits(id) {
  return String(id || '').replace(/@.*/, '').replace(/:.*/, '').replace(/\D/g, '');
}

function allowed(ev) {
  const candidates = [ev.senderId, ev.senderNumber, ev.chatId, ev.from]
    .flatMap((x) => (x ? [digits(x)] : []))
    .filter(Boolean);
  return candidates.some((d) => ALLOWED.has(d));
}

async function getMessages() {
  const r = await fetch(`${BRIDGE}/messages`);
  if (!r.ok) throw new Error(`messages ${r.status}`);
  return r.json();
}

async function sendAck(chatId, text) {
  if (!text) return null;
  const r = await fetch(`${BRIDGE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: text }),
  });
  const body = await r.text();
  return { status: r.status, body };
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return { seen: [], acked: 0, processed: 0 };
  }
}

function saveState(st) {
  // keep last 500 ids
  st.seen = (st.seen || []).slice(-500);
  writeFileSync(STATE, JSON.stringify(st));
}

console.log(`[listener] bridge=${BRIDGE} allow=${[...ALLOWED].join(',')} ack=${ACK ? 'on' : 'off'} wake=${WAKE_URL ? 'on' : 'off'}`);

const st = loadState();
const seen = new Set(st.seen || []);

async function tick() {
  let msgs;
  try {
    msgs = await getMessages();
  } catch (e) {
    console.error('[listener] poll err', e.message);
    return;
  }
  if (!Array.isArray(msgs) || !msgs.length) return;

  for (const ev of msgs) {
    const id = ev.id || ev.messageId || `${ev.chatId}:${ev.ts || ''}:${(ev.body || '').slice(0, 40)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    st.seen.push(id);

    const row = {
      ts: new Date().toISOString(),
      allowed: allowed(ev),
      chatId: ev.chatId,
      senderId: ev.senderId,
      senderName: ev.senderName,
      body: ev.body,
      hasMedia: !!ev.hasMedia,
    };
    appendFileSync(INBOX, JSON.stringify(row) + '\n');
    console.log('[listener] inbound', JSON.stringify(row));

    if (!row.allowed) {
      console.log('[listener] drop (not allowlisted)');
      continue;
    }

    st.processed += 1;
    writeFileSync(path.join(__dirname, 'unread.flag'), `${st.processed}\n`);

    if (WAKE_URL) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (WAKE_AUTH) headers['Authorization'] = WAKE_AUTH.startsWith('Bearer ') || WAKE_AUTH.startsWith('bearer ')
          ? WAKE_AUTH
          : `Bearer ${WAKE_AUTH}`;
        const wr = await fetch(WAKE_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source: 'whatsapp-bridge-listener',
            chatId: ev.chatId,
            senderId: ev.senderId,
            senderName: ev.senderName,
            body: ev.body,
            hasMedia: !!ev.hasMedia,
            ts: row.ts,
          }),
        });
        console.log('[listener] wake', wr.status);
      } catch (e) {
        console.error('[listener] wake err', e.message);
      }
    }

    if (ACK && ev.chatId) {
      try {
        const res = await sendAck(ev.chatId, ACK);
        st.acked += 1;
        console.log('[listener] ack', res?.status, res?.body?.slice?.(0, 120));
      } catch (e) {
        console.error('[listener] ack err', e.message);
      }
    }
  }
  saveState(st);
}

setInterval(() => {
  tick().catch((e) => console.error(e));
}, POLL_MS);

tick().catch((e) => console.error(e));
