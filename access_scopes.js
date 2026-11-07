// Explicit account + chat ceilings. No credentials, aliases or ambient state.
export const ACCOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const CHAT_ID_RE = /^[a-zA-Z0-9._:-]+@(s\.whatsapp\.net|lid|g\.us)$/;
export const isPrivateChat = (chatId) => typeof chatId === 'string'
  && CHAT_ID_RE.test(chatId) && !chatId.endsWith('@g.us');

const FIELDS = new Set(['readAllDms', 'readChats', 'triggerChats', 'sendChats']);
const DENY = Object.freeze({ readAllDms: false, readChats: new Set(), triggerChats: new Set(), sendChats: new Set() });

function chatSet(value, field) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((chat) => typeof chat !== 'string' || !CHAT_ID_RE.test(chat))) {
    throw new Error(`WHATSAPP_SCOPES ${field} must be an array of exact WhatsApp JIDs; wildcards are forbidden.`);
  }
  if (field === 'triggerChats' && value.some((chat) => !isPrivateChat(chat))) {
    throw new Error('WHATSAPP_SCOPES triggerChats supports private conversations only.');
  }
  return new Set(value);
}

// Empty/unset preserves the legacy installation. An explicit {} denies every
// account. Missing fields/accounts NEVER inherit a legacy or another account's
// permission. All-DM reading is a boolean opt-in, not a send/trigger wildcard.
export function parseAccessScopes(raw) {
  if (raw === undefined || String(raw).trim() === '') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('WHATSAPP_SCOPES must be a JSON account-to-policy object.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WHATSAPP_SCOPES must be a JSON account-to-policy object.');
  }
  const accounts = new Map();
  for (const [name, policy] of Object.entries(parsed)) {
    if (!ACCOUNT_NAME_RE.test(name) || !policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('WHATSAPP_SCOPES contains an invalid account or policy.');
    }
    if (Object.keys(policy).some((field) => !FIELDS.has(field))
        || (policy.readAllDms !== undefined && typeof policy.readAllDms !== 'boolean')) {
      throw new Error('WHATSAPP_SCOPES contains an unknown field or a non-boolean readAllDms.');
    }
    accounts.set(name, Object.freeze({
      readAllDms: policy.readAllDms === true,
      readChats: chatSet(policy.readChats, 'readChats'),
      triggerChats: chatSet(policy.triggerChats, 'triggerChats'),
      sendChats: chatSet(policy.sendChats, 'sendChats'),
    }));
  }
  return accounts;
}

export const scopeForAccount = (scopes, name) => scopes === null ? null : (scopes.get(name) || DENY);
export const canReadChat = (scope, chatId) => typeof chatId === 'string' && CHAT_ID_RE.test(chatId)
  && (scope.readChats.has(chatId) || (scope.readAllDms && isPrivateChat(chatId)));
export const canSendChat = (scope, chatId) => typeof chatId === 'string' && CHAT_ID_RE.test(chatId)
  && scope.sendChats.has(chatId);

export function canTriggerEvent(scope, event) {
  // Only provider-observed incoming DMs. Poll aggregations, groups, our own
  // messages and legacy pending wakes with no provenance cannot wake an agent.
  return event?.scopeVersion === 1 && event.eventType === 'message' && event.fromOwner === false
    && isPrivateChat(event.chatId) && canReadChat(scope, event.chatId) && scope.triggerChats.has(event.chatId);
}
