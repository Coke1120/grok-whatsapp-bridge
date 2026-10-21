#!/usr/bin/env node
/**
 * Hermes Agent WhatsApp Bridge
 *
 * One Node process, one HTTP server, one Baileys socket per configured
 * account. With no WHATSAPP_ACCOUNTS and no accounts/*.env, this is the
 * original single-session bridge: unqualified /health /send /messages hit
 * that session and keep the legacy JSON shape.
 *
 *   GET  /messages       - Long-poll for new incoming messages
 *   POST /send           - Send a message { chatId, message, replyTo?, mentions? }
 *   POST /edit           - Edit a sent message { chatId, messageId, message }
 *   POST /send-media     - Send media natively { chatId, filePath, mediaType?, caption?, fileName?, mentions? }
 *   POST /send-location  - Send location pin { chatId, latitude, longitude, name?, address? }
 *   POST /typing         - Send typing indicator { chatId }
 *   GET  /chat/:id       - Get chat info
 *   GET  /health         - Health check (lists accounts when multi is configured)
 *   POST /logout|pause|resume
 *
 * Account selection (first match wins; conflicting selectors return 400):
 *   /accounts/:account/...
 *   X-WhatsApp-Account: name
 *   ?account=name
 *
 * Usage:
 *   node bridge.js --session ~/.hermes/whatsapp/session
 *   node bridge.js                                 # WHATSAPP_BRIDGE_PORT, else 37100
 *   node bridge.js --pair-only --account sales
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { createVersionResolver, installConsoleStamps, readReconnectTiming, resolveListenHost, writeJsonLine } from './bridge_helpers.js';
import { accountForPairing, loadAccountConfigs, resolveRuntimeConfig } from './accounts_config.js';
import { createBridgeApp, parseTrustedHosts } from './account_http.js';
import { createAccountRuntime } from './account_runtime.js';
import { formatAccountStartupLines, formatPairingLines } from './bridge_startup.js';

installConsoleStamps();

const args = process.argv.slice(2);

function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

function hasArg(name) {
  return args.includes(`--${name}`);
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase());
}

function scriptHash() {
  try {
    return createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex')
      .slice(0, 16);
  } catch {
    return '';
  }
}

function cacheDirsFor(accountName, multi) {
  const image = process.env.HERMES_IMAGE_CACHE_DIR
    || path.join(process.env.HOME || '~', '.hermes', 'image_cache');
  const document = process.env.HERMES_DOCUMENT_CACHE_DIR
    || path.join(process.env.HOME || '~', '.hermes', 'document_cache');
  const audio = process.env.HERMES_AUDIO_CACHE_DIR
    || path.join(process.env.HOME || '~', '.hermes', 'audio_cache');
  if (!multi) return { image, document, audio };
  return {
    image: path.join(image, accountName),
    document: path.join(document, accountName),
    audio: path.join(audio, accountName),
  };
}

function runtimeFor(account, shared) {
  const reconnect = readReconnectTiming(process.env);
  return createAccountRuntime({
    name: account.name,
    sessionDir: account.sessionDir,
    mode: account.mode,
    multi: shared.multi,
    pairOnly: shared.pairOnly,
    pairJson: shared.pairJson,
    dmPolicy: account.dmPolicy,
    groupPolicy: account.groupPolicy,
    allowedUsers: account.allowedUsers,
    groupAllowedUsers: account.groupAllowedUsers,
    replyPrefix: account.replyPrefix,
    forwardOwnerMessages: account.forwardOwnerMessages,
    sendReadReceipts: account.sendReadReceipts,
    maxMessageLength: parseInt(process.env.WHATSAPP_MAX_MESSAGE_LENGTH || '4096', 10),
    chunkDelayMs: parseInt(process.env.WHATSAPP_CHUNK_DELAY_MS || '300', 10),
    sendTimeoutMs: parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS || '60000', 10),
    reconnectBaseMs: reconnect.baseMs,
    reconnectCapMs: reconnect.capMs,
    cacheDirs: cacheDirsFor(account.name, shared.multi),
    debug: envFlag('WHATSAPP_DEBUG'),
    deps: { getWAVersion: shared.getWAVersion },
  });
}

export async function main(argvEnv = process.env) {
  const pairOnly = args.includes('--pair-only');
  const pairJson = args.includes('--pair-json');
  const cli = {
    session: hasArg('session') ? getArg('session') : undefined,
    mode: hasArg('mode') ? getArg('mode') : undefined,
    account: hasArg('account') ? getArg('account') : undefined,
  };
  if (cli.account && !pairOnly) {
    throw new Error('--account is only valid with --pair-only. The running bridge starts every configured account. Use WHATSAPP_DEFAULT_ACCOUNT to choose the default route.');
  }

  let config = loadAccountConfigs({ env: argvEnv, cwd: process.cwd(), cli });
  config = resolveRuntimeConfig(config, cli);
  // --port wins. Otherwise WHATSAPP_BRIDGE_PORT, else 37100 (start.sh, Compose, .env.example).
  // An explicit `--port 3000` still works; 3000 is not this repo's unset default.
  const port = parseInt(getArg('port', argvEnv.WHATSAPP_BRIDGE_PORT || '37100'), 10);
  const getWAVersion = createVersionResolver(fetchLatestBaileysVersion);
  const shared = { multi: config.multi, pairOnly, pairJson, getWAVersion };

  if (pairOnly) {
    const account = accountForPairing(config, cli.account);
    if (pairJson) {
      writeJsonLine({
        ts: Date.now(),
        event: 'started',
        session: account.sessionDir,
        ...(config.multi ? { account: account.name } : {}),
      });
    } else {
      for (const line of formatPairingLines({
        multi: config.multi,
        sessionDir: account.sessionDir,
        accountName: account.name,
      })) {
        console.log(line);
      }
    }
    const runtime = runtimeFor(account, shared);
    await runtime.start();
    return;
  }

  const host = resolveListenHost(argvEnv);
  const runtimes = config.accounts.map((account) => runtimeFor(account, shared));
  const app = createBridgeApp({
    accounts: runtimes,
    defaultName: config.defaultName,
    multi: config.multi,
    scriptHash: scriptHash(),
    trustedHosts: parseTrustedHosts(argvEnv.WHATSAPP_TRUSTED_HOSTS),
  });
  if (host !== '127.0.0.1') {
    console.log(`HTTP bind ${host}:${port}. Publish this port on 127.0.0.1 only.`);
  }
  await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
  for (const line of formatAccountStartupLines({
    port,
    accounts: config.accounts,
    defaultName: config.defaultName,
    multi: config.multi,
  })) {
    console.log(line);
  }
  for (const runtime of runtimes) runtime.start();
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
