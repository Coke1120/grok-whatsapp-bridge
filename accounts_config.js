import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

export const DEFAULT_REPLY_PREFIX = '☤ *Hermes Agent*\n────────────\n';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function envFlag(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

export function resolveReplyPrefix(accountValue, env) {
  if (accountValue !== undefined) return String(accountValue).replace(/\\n/g, '\n');
  if (env.WHATSAPP_REPLY_PREFIX === undefined) return DEFAULT_REPLY_PREFIX;
  return String(env.WHATSAPP_REPLY_PREFIX).replace(/\\n/g, '\n');
}

function assertAccountName(name) {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid WhatsApp account name "${name}". Use letters, digits, "_" or "-".`);
  }
}

function resolveMode(raw, env, cli) {
  const explicit = hasOwn(raw, 'mode') && raw.mode != null && String(raw.mode).trim() !== ''
    ? raw.mode
    : undefined;
  const mode = String(explicit || cli.mode || env.WHATSAPP_MODE || 'self-chat').trim().toLowerCase();
  if (mode !== 'bot' && mode !== 'self-chat') {
    throw new Error(`WhatsApp account "${raw.name}" has invalid mode "${mode}". Use bot or self-chat.`);
  }
  return mode;
}

function resolvePolicy(raw, key, env, envKey, fallback) {
  if (hasOwn(raw, key) && raw[key] != null && String(raw[key]).trim() !== '') {
    return String(raw[key]).trim().toLowerCase();
  }
  return String(env[envKey] || fallback).trim().toLowerCase();
}

function resolveFlag(raw, key, env, envKey) {
  if (hasOwn(raw, key)) return envFlag(raw[key]);
  return envFlag(env[envKey]);
}

function optionalString(raw, key) {
  if (!hasOwn(raw, key)) return null;
  return raw[key] == null ? '' : String(raw[key]);
}

function inheritedString(raw, key, env, envKey) {
  if (hasOwn(raw, key)) return raw[key] == null ? '' : String(raw[key]);
  return env[envKey] == null ? '' : String(env[envKey]);
}

function normalizeAccount(raw, env, cli) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Each WhatsApp account must be an object');
  }
  const name = String(raw.name || '').trim();
  assertAccountName(name);
  const sessionDir = raw.sessionDir == null ? '' : String(raw.sessionDir);
  if (!sessionDir.trim()) {
    throw new Error(`WhatsApp account "${name}" is missing sessionDir`);
  }
  return {
    name,
    sessionDir,
    mode: resolveMode({ ...raw, name }, env, cli),
    allowedUsers: inheritedString(raw, 'allowedUsers', env, 'WHATSAPP_ALLOWED_USERS'),
    groupAllowedUsers: inheritedString(raw, 'groupAllowedUsers', env, 'WHATSAPP_GROUP_ALLOWED_USERS'),
    dmPolicy: resolvePolicy(raw, 'dmPolicy', env, 'WHATSAPP_DM_POLICY', 'open'),
    groupPolicy: resolvePolicy(raw, 'groupPolicy', env, 'WHATSAPP_GROUP_POLICY', 'pairing'),
    replyPrefix: resolveReplyPrefix(hasOwn(raw, 'replyPrefix') ? raw.replyPrefix : undefined, env),
    forwardOwnerMessages: resolveFlag(raw, 'forwardOwnerMessages', env, 'WHATSAPP_FORWARD_OWNER_MESSAGES'),
    sendReadReceipts: resolveFlag(raw, 'sendReadReceipts', env, 'WHATSAPP_SEND_READ_RECEIPTS'),
    programmaticAck: optionalString(raw, 'programmaticAck'),
    wakeWebhookUrl: optionalString(raw, 'wakeWebhookUrl'),
    wakeWebhookAuth: optionalString(raw, 'wakeWebhookAuth'),
  };
}

function assertDistinctAccounts(accounts, cwd) {
  const names = new Set();
  const sessions = new Map();
  for (const account of accounts) {
    if (names.has(account.name)) {
      throw new Error(`Duplicate WhatsApp account name "${account.name}"`);
    }
    names.add(account.name);
    const resolved = path.resolve(cwd, account.sessionDir);
    const previous = sessions.get(resolved);
    if (previous) {
      throw new Error(`Duplicate session directory for accounts ${previous} and ${account.name}: ${resolved}`);
    }
    sessions.set(resolved, account.name);
  }
}

function pickDefaultName(accounts, explicitDefault, env) {
  const fromEnv = env.WHATSAPP_DEFAULT_ACCOUNT && String(env.WHATSAPP_DEFAULT_ACCOUNT).trim();
  const name = fromEnv || explicitDefault || accounts[0].name;
  if (!accounts.some((account) => account.name === name)) {
    const known = accounts.map((account) => account.name).join(', ');
    throw new Error(`Default WhatsApp account "${name}" is not in the account list (${known})`);
  }
  return name;
}

function parseAccountsSpec(raw, cwd) {
  const text = String(raw || '').trim();
  let parsed;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`WHATSAPP_ACCOUNTS is not valid JSON: ${err.message}`);
    }
  } else {
    const filePath = path.resolve(cwd, text);
    if (!existsSync(filePath)) {
      throw new Error(`WHATSAPP_ACCOUNTS must be JSON or a path to a JSON file (got ${text})`);
    }
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error(`Could not read WHATSAPP_ACCOUNTS file ${filePath}: ${err.message}`);
    }
  }
  if (Array.isArray(parsed)) return { defaultName: null, accounts: parsed };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
    return {
      defaultName: parsed.default ? String(parsed.default) : null,
      accounts: parsed.accounts,
    };
  }
  if (parsed && typeof parsed === 'object' && parsed.name && parsed.sessionDir) {
    return { defaultName: null, accounts: [parsed] };
  }
  throw new Error('WHATSAPP_ACCOUNTS must be an array of accounts or { "default", "accounts" }');
}

export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2
      && (value[0] === '"' || value[0] === "'")
      && value[0] === value[value.length - 1]
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const ENV_FILE_KEYS = [
  ['WHATSAPP_MODE', 'mode'],
  ['WHATSAPP_ALLOWED_USERS', 'allowedUsers'],
  ['WHATSAPP_GROUP_ALLOWED_USERS', 'groupAllowedUsers'],
  ['WHATSAPP_DM_POLICY', 'dmPolicy'],
  ['WHATSAPP_GROUP_POLICY', 'groupPolicy'],
  ['WHATSAPP_REPLY_PREFIX', 'replyPrefix'],
  ['WHATSAPP_FORWARD_OWNER_MESSAGES', 'forwardOwnerMessages'],
  ['WHATSAPP_SEND_READ_RECEIPTS', 'sendReadReceipts'],
  ['WHATSAPP_PROGRAMMATIC_ACK', 'programmaticAck'],
  ['WHATSAPP_WAKE_WEBHOOK_URL', 'wakeWebhookUrl'],
  ['WHATSAPP_WAKE_WEBHOOK_AUTH', 'wakeWebhookAuth'],
];

function accountFromEnvFile(fileName, envMap) {
  const stem = fileName.slice(0, -'.env'.length);
  const name = String(envMap.WHATSAPP_ACCOUNT_NAME || stem).trim();
  const raw = {
    name,
    sessionDir: envMap.WHATSAPP_SESSION_DIR,
  };
  for (const [envKey, field] of ENV_FILE_KEYS) {
    if (hasOwn(envMap, envKey)) raw[field] = envMap[envKey];
  }
  return raw;
}

function discoverAccountEnvFiles(cwd, env) {
  const folder = env.WHATSAPP_ACCOUNTS_DIR
    ? path.resolve(cwd, env.WHATSAPP_ACCOUNTS_DIR)
    : path.join(cwd, 'accounts');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => file.endsWith('.env') && !file.startsWith('.'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => accountFromEnvFile(file, parseEnvFile(readFileSync(path.join(folder, file), 'utf8'))));
}

function singleConfig(env, cli, cwd) {
  const account = normalizeAccount({
    name: 'default',
    sessionDir: cli.session
      || env.WHATSAPP_SESSION_DIR
      || path.join(env.HOME || '~', '.hermes', 'whatsapp', 'session'),
  }, env, cli);
  return {
    multi: false,
    source: 'single',
    defaultName: 'default',
    cwd,
    accounts: [account],
  };
}

export function loadAccountConfigs({
  env = process.env,
  cwd = process.cwd(),
  cli = {},
  warn = console.warn,
} = {}) {
  const specRaw = env.WHATSAPP_ACCOUNTS;
  const spec = specRaw && String(specRaw).trim() ? parseAccountsSpec(specRaw, cwd) : null;
  const fromDir = discoverAccountEnvFiles(cwd, env);

  if (!spec && fromDir.length === 0) return singleConfig(env, cli, cwd);

  if (spec && fromDir.length > 0) {
    warn('WHATSAPP_ACCOUNTS is set; ignoring accounts/*.env files.');
  }

  const rawAccounts = spec ? spec.accounts : fromDir;
  if (!rawAccounts.length) {
    throw new Error('Multi-account config has no accounts');
  }
  const accounts = rawAccounts.map((raw) => normalizeAccount(raw, env, cli));
  assertDistinctAccounts(accounts, cwd);
  return {
    multi: true,
    source: spec ? 'json' : 'dir',
    defaultName: pickDefaultName(accounts, spec ? spec.defaultName : null, env),
    cwd,
    accounts,
  };
}

export function resolveRuntimeConfig(config, cli = {}) {
  if (!cli.session || !config.multi) return config;
  if (!cli.account) {
    throw new Error(
      'Cannot pass --session when multi-account is configured. Put sessionDir on each account (WHATSAPP_ACCOUNTS or accounts/*.env). To override one account while pairing: --pair-only --account <name> --session <dir>.',
    );
  }
  const accounts = config.accounts.map((account) => ({ ...account }));
  const target = accounts.find((account) => account.name === cli.account);
  if (!target) {
    const known = accounts.map((account) => account.name).join(', ');
    throw new Error(`Unknown WhatsApp account "${cli.account}". Known: ${known}`);
  }
  target.sessionDir = cli.session;
  assertDistinctAccounts(accounts, config.cwd || process.cwd());
  return { ...config, accounts };
}

export function accountForPairing(config, accountName) {
  if (!accountName) {
    if (config.multi) {
      throw new Error('Pairing multiple accounts requires an account name. Example: ./pair.sh sales');
    }
    return config.accounts[0];
  }
  const found = config.accounts.find((account) => account.name === accountName);
  if (!found) {
    const known = config.accounts.map((account) => account.name).join(', ');
    throw new Error(`Unknown WhatsApp account "${accountName}". Known: ${known}`);
  }
  return found;
}
