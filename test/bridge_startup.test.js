import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAccountStartupLines, formatPairingLines } from '../bridge_startup.js';

test('single-account listen banner matches the historical lines', () => {
  const lines = formatAccountStartupLines({
    port: 37100,
    multi: false,
    defaultName: 'default',
    accounts: [{
      name: 'default',
      mode: 'bot',
      sessionDir: './session',
      allowedUsers: '',
      dmPolicy: 'open',
      forwardOwnerMessages: false,
    }],
  });
  assert.deepEqual(lines, [
    '🌉 WhatsApp bridge listening on port 37100 (mode: bot)',
    '📁 Session stored in: ./session',
    '🔒 No WHATSAPP_ALLOWED_USERS set — incoming messages are rejected.',
    '   Set WHATSAPP_ALLOWED_USERS=<phone> to authorize specific users,',
    '   or WHATSAPP_ALLOWED_USERS=* for an explicit open bot.',
    '',
  ]);
});

test('self-chat, allowlist, pairing policy, and owner-forward lines stay word for word', () => {
  const selfChat = formatAccountStartupLines({
    port: 37100,
    multi: false,
    defaultName: 'default',
    accounts: [{
      name: 'default',
      mode: 'self-chat',
      sessionDir: '/data/session',
      allowedUsers: '',
      dmPolicy: 'open',
      forwardOwnerMessages: false,
    }],
  });
  assert.equal(selfChat[2], '🔒 Self-chat mode — only your own messages to yourself are processed.');

  const allowlist = formatAccountStartupLines({
    port: 3000,
    multi: false,
    defaultName: 'default',
    accounts: [{
      name: 'default',
      mode: 'bot',
      sessionDir: '/data/session',
      allowedUsers: '111,222',
      dmPolicy: 'pairing',
      forwardOwnerMessages: true,
    }],
  });
  assert.equal(allowlist[0], '🌉 WhatsApp bridge listening on port 3000 (mode: bot)');
  assert.equal(allowlist[2], '🔒 Allowed users: 111, 222');
  assert.equal(
    allowlist[3],
    '👤 WHATSAPP_FORWARD_OWNER_MESSAGES=true — owner-typed messages will be forwarded with fromOwner:true',
  );

  const pairing = formatAccountStartupLines({
    port: 37100,
    multi: false,
    defaultName: 'default',
    accounts: [{
      name: 'default',
      mode: 'bot',
      sessionDir: '/data/session',
      allowedUsers: '',
      dmPolicy: 'pairing',
      forwardOwnerMessages: false,
    }],
  });
  assert.equal(pairing[2], '🤝 WHATSAPP_DM_POLICY=pairing — unknown DMs are forwarded for gateway pairing.');
});

test('multi-account banner names every account and keeps the same policy lines', () => {
  const lines = formatAccountStartupLines({
    port: 37100,
    multi: true,
    defaultName: 'ops',
    accounts: [
      {
        name: 'ops',
        mode: 'bot',
        sessionDir: './session',
        allowedUsers: '111',
        dmPolicy: 'open',
        forwardOwnerMessages: false,
      },
      {
        name: 'sales',
        mode: 'bot',
        sessionDir: './sessions/sales',
        allowedUsers: '',
        dmPolicy: 'open',
        forwardOwnerMessages: false,
      },
    ],
  });
  assert.equal(lines[0], '🌉 WhatsApp bridge listening on port 37100 (accounts: ops, sales; default: ops)');
  assert.ok(lines.includes('[ops] 📁 Session stored in: ./session'));
  assert.ok(lines.includes('[sales] 📁 Session stored in: ./sessions/sales'));
  assert.ok(lines.includes('[ops] 🔒 Allowed users: 111'));
  assert.equal(lines.at(-1), '');
});

test('pairing banner is unchanged unless an account name is in play', () => {
  assert.deepEqual(formatPairingLines({ multi: false, sessionDir: './session', accountName: 'default' }), [
    '📱 WhatsApp pairing mode',
    '📁 Session: ./session',
    '',
  ]);
  assert.equal(
    formatPairingLines({ multi: true, sessionDir: './sessions/sales', accountName: 'sales' })[0],
    '📱 WhatsApp pairing mode (account: sales)',
  );
});
