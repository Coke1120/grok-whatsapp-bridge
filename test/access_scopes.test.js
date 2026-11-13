import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAccessScopes, scopeForAccount, canReadChat, canSendChat, canTriggerEvent } from '../access_scopes.js';
import { loadAccountConfigs } from '../accounts_config.js';

const OWNER = '15550000001@lid';
const OTHER = '15550000002@s.whatsapp.net';
const GROUP = '15550000001@g.us';
const policy = (p = {}) => scopeForAccount(parseAccessScopes(JSON.stringify({ default: p })), 'default');
const event = (p = {}) => ({ chatId: OWNER, scopeVersion: 1, eventType: 'message', fromOwner: false, ...p });

test('independent scopes are opt-in and explicit empty policy denies everything', () => {
  assert.equal(parseAccessScopes(undefined), null);
  assert.equal(parseAccessScopes(''), null);
  for (const raw of ['{}', '{"other":{}}']) {
    const scope = scopeForAccount(parseAccessScopes(raw), 'default');
    assert.equal(canReadChat(scope, OWNER), false);
    assert.equal(canSendChat(scope, OWNER), false);
    assert.equal(canTriggerEvent(scope, event()), false);
  }
});

test('all-DM read never grants triggering, sending or group access', () => {
  const scope = policy({ readAllDms: true, triggerChats: [OWNER], sendChats: [OWNER] });
  assert(canReadChat(scope, OTHER));
  assert(canTriggerEvent(scope, event()));
  assert(canSendChat(scope, OWNER));
  assert.equal(canSendChat(scope, OTHER), false);
  assert.equal(canTriggerEvent(scope, event({ chatId: OTHER })), false);
  assert.equal(canReadChat(scope, GROUP), false);
  assert.equal(canReadChat(scope, 'status@broadcast'), false);
});

test('send, read and wake lists do not inherit each other; full JID types stay distinct', () => {
  const scope = policy({ readChats: [OTHER], triggerChats: [OWNER], sendChats: [OWNER] });
  assert(canReadChat(scope, OTHER));
  assert.equal(canSendChat(scope, OTHER), false);
  assert.equal(canReadChat(scope, OWNER), false);
  assert.equal(canTriggerEvent(scope, event()), false);
  assert(canSendChat(scope, OWNER));
  assert.equal(canSendChat(scope, OWNER.replace('@lid', '@s.whatsapp.net')), false);
  assert.equal(canReadChat(scope, GROUP), false);
});

test('only current provider-observed incoming private text events can wake', () => {
  const scope = policy({ readAllDms: true, triggerChats: [OWNER] });
  for (const denied of [{ scopeVersion: undefined }, { fromOwner: true }, { fromOwner: undefined },
    { eventType: 'poll_update' }, { eventType: undefined }, { chatId: GROUP },
    { chatId: OTHER, senderId: OWNER, quotedParticipant: OWNER }]) {
    assert.equal(canTriggerEvent(scope, event(denied)), false);
  }
  assert(canTriggerEvent(scope, event()));
});

test('scope parser fails closed for malformed, wildcard, unknown and ambiguous fields', () => {
  for (const raw of ['null', '[]', 'no', '{"../ops":{}}', '{"default":null}',
    '{"default":{"readAllDms":"true"}}', '{"default":{"readAll":true}}',
    '{"default":{"readChats":["*"]}}', '{"default":{"sendChats":"all"}}',
    '{"default":{"triggerChats":["123@g.us"]}}', '{"default":{"sendChats":["1@evil.net"]}}']) {
    assert.throws(() => parseAccessScopes(raw), /WHATSAPP_SCOPES/);
  }
});

test('configuration binds each account to its own policy and never uses legacy allowlist as a fallback', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wa-scope-config-'));
  try {
    const config = loadAccountConfigs({ cwd: dir, env: {
      WHATSAPP_ALLOWED_USERS: '*',
      WHATSAPP_ACCOUNTS: JSON.stringify([
        { name: 'ops', sessionDir: './ops' }, { name: 'sales', sessionDir: './sales' },
      ]),
      WHATSAPP_SCOPES: JSON.stringify({ ops: { readAllDms: true, sendChats: [OWNER] }, sales: {} }),
    } });
    assert(canReadChat(config.accounts[0].accessScope, OTHER));
    assert(canSendChat(config.accounts[0].accessScope, OWNER));
    assert.equal(canReadChat(config.accounts[1].accessScope, OTHER), false);
    assert.equal(canSendChat(config.accounts[1].accessScope, OWNER), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scope JIDs and account names reject final newlines rather than treating groups as DMs', () => {
  for (const suffix of ['\n', '\r', '\u2028']) {
    assert.throws(() => parseAccessScopes(JSON.stringify({ default: { readChats: ['123@g.us' + suffix] } })));
    assert.throws(() => parseAccessScopes(JSON.stringify({ ['default' + suffix]: { readAllDms: true } })));
    const policy = scopeForAccount(parseAccessScopes(JSON.stringify({ default: { readAllDms: true } })), 'default');
    assert.equal(canReadChat(policy, '123@g.us' + suffix), false);
  }
});
