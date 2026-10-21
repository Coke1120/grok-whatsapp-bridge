import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPLY_PREFIX,
  accountForPairing,
  loadAccountConfigs,
  resolveRuntimeConfig,
} from '../accounts_config.js';

let dir;

test.beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-cfg-'));
});

test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('no multi config keeps a single implicit account', () => {
  const session = path.join(dir, 'session');
  const cfg = loadAccountConfigs({
    env: { WHATSAPP_ALLOWED_USERS: '111, 222', WHATSAPP_MODE: 'self-chat' },
    cwd: dir,
    cli: { session, mode: 'bot' },
  });

  assert.equal(cfg.multi, false);
  assert.equal(cfg.source, 'single');
  assert.equal(cfg.defaultName, 'default');
  assert.equal(cfg.accounts.length, 1);
  assert.equal(cfg.accounts[0].name, 'default');
  assert.equal(cfg.accounts[0].sessionDir, session);
  assert.equal(cfg.accounts[0].mode, 'bot');
  assert.equal(cfg.accounts[0].allowedUsers, '111, 222');
  assert.equal(cfg.accounts[0].replyPrefix, DEFAULT_REPLY_PREFIX);
  assert.equal(cfg.accounts[0].programmaticAck, null);
  assert.equal(cfg.accounts[0].wakeWebhookUrl, null);
});

test('falls back to the historical Hermes session path when no session is configured', () => {
  const cfg = loadAccountConfigs({
    env: { HOME: '/home/example' },
    cwd: dir,
    cli: {},
  });
  assert.equal(cfg.multi, false);
  assert.equal(cfg.accounts[0].mode, 'self-chat');
  assert.equal(cfg.accounts[0].sessionDir, path.join('/home/example', '.hermes', 'whatsapp', 'session'));
});

test('WHATSAPP_ACCOUNTS JSON configures named accounts and env can override the default', () => {
  const cfg = loadAccountConfigs({
    env: {
      WHATSAPP_ACCOUNTS: JSON.stringify({
        default: 'ops',
        accounts: [
          { name: 'sales', sessionDir: './sessions/sales', mode: 'bot', allowedUsers: '222' },
          { name: 'ops', sessionDir: './session', replyPrefix: '' },
        ],
      }),
      WHATSAPP_DEFAULT_ACCOUNT: 'sales',
      WHATSAPP_MODE: 'bot',
      WHATSAPP_FORWARD_OWNER_MESSAGES: 'true',
      WHATSAPP_ALLOWED_USERS: '111',
    },
    cwd: dir,
    cli: { mode: 'self-chat' },
  });

  assert.equal(cfg.multi, true);
  assert.equal(cfg.source, 'json');
  assert.equal(cfg.defaultName, 'sales');
  assert.deepEqual(cfg.accounts.map((account) => account.name), ['sales', 'ops']);
  assert.equal(cfg.accounts[0].sessionDir, './sessions/sales');
  assert.equal(cfg.accounts[0].mode, 'bot');
  assert.equal(cfg.accounts[0].allowedUsers, '222');
  assert.equal(cfg.accounts[1].mode, 'self-chat');
  assert.equal(cfg.accounts[1].allowedUsers, '111');
  assert.equal(cfg.accounts[1].replyPrefix, '');
  assert.equal(cfg.accounts[1].forwardOwnerMessages, true);
  assert.equal(cfg.accounts[0].forwardOwnerMessages, true);
});

test('an explicit false on an account overrides the inherited env flag', () => {
  const cfg = loadAccountConfigs({
    env: {
      WHATSAPP_ACCOUNTS: JSON.stringify([
        { name: 'ops', sessionDir: './session', forwardOwnerMessages: false, sendReadReceipts: true },
      ]),
      WHATSAPP_FORWARD_OWNER_MESSAGES: 'yes',
      WHATSAPP_SEND_READ_RECEIPTS: 'no',
    },
    cwd: dir,
    cli: {},
  });
  assert.equal(cfg.multi, true);
  assert.equal(cfg.accounts[0].forwardOwnerMessages, false);
  assert.equal(cfg.accounts[0].sendReadReceipts, true);
  assert.equal(cfg.defaultName, 'ops');
});

test('a JSON file path is accepted and account wake settings can opt out', () => {
  const file = path.join(dir, 'accounts.json');
  writeFileSync(file, JSON.stringify([
    {
      name: 'ops',
      sessionDir: './session',
      programmaticAck: '',
      wakeWebhookUrl: '',
      wakeWebhookAuth: '',
    },
  ]));
  const cfg = loadAccountConfigs({
    env: {
      WHATSAPP_ACCOUNTS: file,
      WHATSAPP_PROGRAMMATIC_ACK: 'inherited',
      WHATSAPP_WAKE_WEBHOOK_URL: 'https://example.invalid/wake',
    },
    cwd: dir,
    cli: {},
  });
  assert.equal(cfg.accounts[0].programmaticAck, '');
  assert.equal(cfg.accounts[0].wakeWebhookUrl, '');
  assert.equal(cfg.accounts[0].wakeWebhookAuth, '');
});

test('accounts/*.env is multi mode and example files are ignored', () => {
  const accountsDir = path.join(dir, 'accounts');
  mkdirSync(accountsDir);
  writeFileSync(path.join(accountsDir, 'sales.env.example'), 'WHATSAPP_SESSION_DIR=./sessions/sales\n');
  writeFileSync(path.join(accountsDir, 'b.env'), [
    'WHATSAPP_SESSION_DIR=./sessions/b',
    'WHATSAPP_MODE=self-chat',
    'WHATSAPP_ALLOWED_USERS=',
    'WHATSAPP_PROGRAMMATIC_ACK=ack-b',
  ].join('\n'));
  writeFileSync(path.join(accountsDir, 'a.env'), 'WHATSAPP_SESSION_DIR=./sessions/a\n');

  const ignored = loadAccountConfigs({
    env: {},
    cwd: dir,
    cli: { session: path.join(dir, 'session') },
  });
  assert.equal(ignored.multi, true);
  assert.equal(ignored.source, 'dir');
  assert.deepEqual(ignored.accounts.map((account) => account.name), ['a', 'b']);
  assert.equal(ignored.defaultName, 'a');
  assert.equal(ignored.accounts[0].sessionDir, './sessions/a');
  assert.equal(ignored.accounts[0].allowedUsers, '');
  assert.equal(ignored.accounts[0].programmaticAck, null);
  assert.equal(ignored.accounts[1].allowedUsers, '');
  assert.equal(ignored.accounts[1].mode, 'self-chat');
  assert.equal(ignored.accounts[1].programmaticAck, 'ack-b');
});

test('only example env files do not enable multi mode', () => {
  mkdirSync(path.join(dir, 'accounts'));
  writeFileSync(path.join(dir, 'accounts', 'sales.env.example'), 'WHATSAPP_SESSION_DIR=./sessions/sales\n');
  const cfg = loadAccountConfigs({
    env: { WHATSAPP_ACCOUNTS_DIR: path.join(dir, 'accounts') },
    cwd: dir,
    cli: { session: path.join(dir, 'session'), mode: 'bot' },
  });
  assert.equal(cfg.multi, false);
  assert.equal(cfg.accounts[0].sessionDir, path.join(dir, 'session'));
});

test('WHATSAPP_ACCOUNTS wins over accounts/*.env', () => {
  mkdirSync(path.join(dir, 'accounts'));
  writeFileSync(path.join(dir, 'accounts', 'dir.env'), 'WHATSAPP_SESSION_DIR=./sessions/dir\n');
  const warnings = [];
  const cfg = loadAccountConfigs({
    env: {
      WHATSAPP_ACCOUNTS: JSON.stringify([{ name: 'json', sessionDir: './session' }]),
    },
    cwd: dir,
    cli: {},
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(cfg.accounts.map((account) => account.name), ['json']);
  assert.match(warnings.join('\n'), /accounts\/\*\.env/);
});

test('duplicate names, bad names, and the same session directory are rejected', () => {
  assert.throws(
    () => loadAccountConfigs({
      env: { WHATSAPP_ACCOUNTS: JSON.stringify([
        { name: 'ops', sessionDir: './session' },
        { name: 'ops', sessionDir: './sessions/ops' },
      ]) },
      cwd: dir,
      cli: {},
    }),
    /duplicate/i,
  );
  assert.throws(
    () => loadAccountConfigs({
      env: { WHATSAPP_ACCOUNTS: JSON.stringify([{ name: '../ops', sessionDir: './session' }]) },
      cwd: dir,
      cli: {},
    }),
    /account name/i,
  );
  assert.throws(
    () => loadAccountConfigs({
      env: { WHATSAPP_ACCOUNTS: JSON.stringify([
        { name: 'ops', sessionDir: './session' },
        { name: 'sales', sessionDir: 'session' },
      ]) },
      cwd: dir,
      cli: {},
    }),
    /session/i,
  );
});

test('server --session is refused in multi mode unless it overrides one pairing account', () => {
  const cfg = loadAccountConfigs({
    env: { WHATSAPP_ACCOUNTS: JSON.stringify([
      { name: 'ops', sessionDir: './session' },
      { name: 'sales', sessionDir: './sessions/sales' },
    ]) },
    cwd: dir,
    cli: {},
  });
  assert.throws(
    () => resolveRuntimeConfig(cfg, { session: './other' }),
    /--session/,
  );
  const overridden = resolveRuntimeConfig(cfg, { session: './tmp-sales', account: 'sales' });
  assert.equal(overridden.accounts.find((account) => account.name === 'sales').sessionDir, './tmp-sales');
  assert.equal(cfg.accounts.find((account) => account.name === 'sales').sessionDir, './sessions/sales');
});

test('accounts.example.json keeps the historical ./session directory on the default account', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cfg = loadAccountConfigs({
    env: {
      WHATSAPP_ACCOUNTS: path.join(root, 'accounts.example.json'),
      WHATSAPP_ACCOUNTS_DIR: path.join(dir, 'empty-accounts'),
    },
    cwd: root,
    cli: {},
    warn() {},
  });
  assert.equal(cfg.multi, true);
  assert.equal(cfg.defaultName, 'primary');
  assert.equal(cfg.accounts[0].sessionDir, './session');
  assert.equal(cfg.accounts[1].name, 'sales');
  assert.equal(cfg.accounts[1].sessionDir, './sessions/sales');
});

test('pairing requires a name only when more than the implicit account exists', () => {
  const single = loadAccountConfigs({
    env: {},
    cwd: dir,
    cli: { session: path.join(dir, 'session') },
  });
  assert.equal(accountForPairing(single).name, 'default');
  assert.throws(() => accountForPairing(single, 'sales'), /Unknown WhatsApp account/);

  const multi = loadAccountConfigs({
    env: { WHATSAPP_ACCOUNTS: JSON.stringify([
      { name: 'ops', sessionDir: './session' },
      { name: 'sales', sessionDir: './sessions/sales' },
    ]) },
    cwd: dir,
    cli: {},
  });
  assert.throws(() => accountForPairing(multi), /account name/);
  assert.equal(accountForPairing(multi, 'sales').name, 'sales');
});
