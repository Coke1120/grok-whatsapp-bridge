import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function startBridge(args, env) {
  const child = spawn(process.execPath, ['bridge.js', ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return {
    child,
    output: () => output.slice(-1500),
  };
}

async function stopBridge(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function request(port, method, urlPath, { headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
}

async function waitForHealth(port, bridge) {
  const deadline = Date.now() + 8000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (bridge.child.exitCode != null) {
      throw new Error(`bridge exited ${bridge.child.exitCode}: ${bridge.output()}`);
    }
    try {
      return await request(port, 'GET', '/health');
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`health never responded (${lastError?.message}). ${bridge.output()}`);
}

function singleEnv(dir, extra = {}) {
  return {
    ...process.env,
    WHATSAPP_ACCOUNTS: '',
    WHATSAPP_DEFAULT_ACCOUNT: '',
    WHATSAPP_ACCOUNT: '',
    WHATSAPP_ACCOUNTS_DIR: path.join(dir, 'no-accounts'),
    WHATSAPP_ALLOWED_USERS: '',
    WHATSAPP_MODE: 'bot',
    WHATSAPP_BIND_HOST: '',
    ...extra,
  };
}

test('wildcard bind still answers loopback /health', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-smoke-bind-'));
  const session = path.join(dir, 'session');
  const port = freePort();
  const bridge = startBridge(
    ['--port', String(port), '--session', session, '--mode', 'bot'],
    singleEnv(dir, { WHATSAPP_BIND_HOST: '0.0.0.0' }),
  );
  try {
    const health = await waitForHealth(port, bridge);
    assert.equal(health.status, 200);
    assert.equal(health.json.session, session);
    const logDeadline = Date.now() + 2000;
    while (Date.now() < logDeadline && !/HTTP bind 0\.0\.0\.0:/.test(bridge.output())) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(bridge.output(), /HTTP bind 0\.0\.0\.0:/);
  } finally {
    await stopBridge(bridge.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a concrete LAN bind address exits before listen', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-smoke-bind-reject-'));
  const session = path.join(dir, 'session');
  const port = freePort();
  const bridge = startBridge(
    ['--port', String(port), '--session', session, '--mode', 'bot'],
    singleEnv(dir, { WHATSAPP_BIND_HOST: '192.168.1.9' }),
  );
  try {
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 20000);
      bridge.child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exit, 1);
    assert.match(bridge.output(), /WHATSAPP_BIND_HOST/);
  } finally {
    await stopBridge(bridge.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default config serves the legacy single-session health shape', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-smoke-single-'));
  const session = path.join(dir, 'session');
  const port = freePort();
  const bridge = startBridge(
    ['--port', String(port), '--session', session, '--mode', 'bot'],
    {
      ...process.env,
      WHATSAPP_ACCOUNTS: '',
      WHATSAPP_DEFAULT_ACCOUNT: '',
      WHATSAPP_ACCOUNT: '',
      WHATSAPP_ACCOUNTS_DIR: path.join(dir, 'no-accounts'),
      WHATSAPP_ALLOWED_USERS: '',
      WHATSAPP_MODE: 'bot',
      WHATSAPP_BIND_HOST: '',
    },
  );
  try {
    const health = await waitForHealth(port, bridge);
    assert.equal(health.status, 200);
    assert.equal(health.json.session, session);
    assert.equal(typeof health.json.status, 'string');
    assert.equal(health.json.capabilities.outboundMentions, true);
    assert.equal(Object.hasOwn(health.json, 'accounts'), false);
    assert.equal(Object.hasOwn(health.json, 'multi'), false);
    assert.match(health.json.scriptHash, /^[a-f0-9]{16}$/);

    const send = await request(port, 'POST', '/send', {
      body: { chatId: '111@s.whatsapp.net', message: 'hi' },
    });
    if (health.json.status !== 'connected') {
      assert.equal(send.status, 503);
      assert.deepEqual(send.json, { error: 'Not connected to WhatsApp' });
    }
  } finally {
    await stopBridge(bridge.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configured accounts are listed and selectable without changing the default route', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-smoke-multi-'));
  const opsSession = path.join(dir, 'session');
  const salesSession = path.join(dir, 'sales');
  const port = freePort();
  const bridge = startBridge(
    ['--port', String(port)],
    {
      ...process.env,
      WHATSAPP_ACCOUNTS: JSON.stringify({
        default: 'ops',
        accounts: [
          { name: 'ops', sessionDir: opsSession, mode: 'bot', allowedUsers: '' },
          { name: 'sales', sessionDir: salesSession, mode: 'bot', allowedUsers: '' },
        ],
      }),
      WHATSAPP_DEFAULT_ACCOUNT: '',
      WHATSAPP_ACCOUNT: '',
      WHATSAPP_ACCOUNTS_DIR: path.join(dir, 'no-accounts'),
      WHATSAPP_ALLOWED_USERS: '',
      WHATSAPP_MODE: 'bot',
      WHATSAPP_BIND_HOST: '',
    },
  );
  try {
    const health = await waitForHealth(port, bridge);
    assert.equal(health.status, 200);
    assert.equal(health.json.multi, true);
    assert.equal(health.json.defaultAccount, 'ops');
    assert.equal(health.json.session, opsSession);
    assert.deepEqual(health.json.accounts.map((account) => account.name), ['ops', 'sales']);
    assert.equal(health.json.accounts[0].session, opsSession);
    assert.equal(health.json.accounts[1].session, salesSession);

    const sales = await request(port, 'GET', '/health?account=sales');
    assert.equal(sales.json.account, 'sales');
    assert.equal(sales.json.session, salesSession);

    const byHeader = await request(port, 'GET', '/accounts/ops/health', {
      headers: { 'x-whatsapp-account': 'ops' },
    });
    assert.equal(byHeader.json.account, 'ops');
    assert.equal(byHeader.json.session, opsSession);

    const missing = await request(port, 'POST', '/send', {
      headers: { 'x-whatsapp-account': 'nope' },
      body: { chatId: '111@s.whatsapp.net', message: 'hi' },
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json.accounts, ['ops', 'sales']);

    const conflict = await request(port, 'POST', '/accounts/ops/send?account=sales', {
      body: { chatId: '111@s.whatsapp.net', message: 'hi' },
    });
    assert.equal(conflict.status, 400);

    const paused = await request(port, 'POST', '/accounts/sales/pause');
    assert.equal(paused.status, 200);
    assert.equal(paused.json.status, 'paused');
    const after = await request(port, 'GET', '/accounts/sales/health');
    assert.equal(after.json.status, 'paused');
    const ops = await request(port, 'GET', '/health');
    assert.equal(ops.json.accounts.find((account) => account.name === 'ops').status !== 'paused', true);
  } finally {
    await stopBridge(bridge.child);
    rmSync(dir, { recursive: true, force: true });
  }
});
