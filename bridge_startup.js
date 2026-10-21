import { parseAllowedUsers } from './allowlist.js';

function allowLines(account) {
  const allowed = parseAllowedUsers(account.allowedUsers || '');
  if (allowed.size > 0) {
    return [`🔒 Allowed users: ${Array.from(allowed).join(', ')}`];
  }
  if (account.mode === 'self-chat') {
    return ['🔒 Self-chat mode — only your own messages to yourself are processed.'];
  }
  if (account.mode === 'bot' && account.dmPolicy === 'pairing') {
    return ['🤝 WHATSAPP_DM_POLICY=pairing — unknown DMs are forwarded for gateway pairing.'];
  }
  return [
    '🔒 No WHATSAPP_ALLOWED_USERS set — incoming messages are rejected.',
    '   Set WHATSAPP_ALLOWED_USERS=<phone> to authorize specific users,',
    '   or WHATSAPP_ALLOWED_USERS=* for an explicit open bot.',
  ];
}

function forwardLines(account) {
  if (account.mode === 'bot' && account.forwardOwnerMessages) {
    return ['👤 WHATSAPP_FORWARD_OWNER_MESSAGES=true — owner-typed messages will be forwarded with fromOwner:true'];
  }
  return [];
}

export function formatAccountStartupLines({ port, accounts, defaultName, multi }) {
  if (!multi) {
    const account = accounts[0];
    return [
      `🌉 WhatsApp bridge listening on port ${port} (mode: ${account.mode})`,
      `📁 Session stored in: ${account.sessionDir}`,
      ...allowLines(account),
      ...forwardLines(account),
      '',
    ];
  }

  const lines = [
    `🌉 WhatsApp bridge listening on port ${port} (accounts: ${accounts.map((account) => account.name).join(', ')}; default: ${defaultName})`,
  ];
  for (const account of accounts) {
    lines.push(`[${account.name}] mode: ${account.mode}`);
    lines.push(`[${account.name}] 📁 Session stored in: ${account.sessionDir}`);
    for (const line of allowLines(account)) lines.push(`[${account.name}] ${line}`);
    for (const line of forwardLines(account)) lines.push(`[${account.name}] ${line}`);
  }
  lines.push('');
  return lines;
}

export function formatPairingLines({ multi, sessionDir, accountName }) {
  if (!multi) {
    return [
      '📱 WhatsApp pairing mode',
      `📁 Session: ${sessionDir}`,
      '',
    ];
  }
  return [
    `📱 WhatsApp pairing mode (account: ${accountName})`,
    `📁 Session: ${sessionDir}`,
    '',
  ];
}
