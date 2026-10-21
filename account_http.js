import express from 'express';

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

function hostOnly(raw) {
  return (raw.includes(':')
    ? raw.substring(0, raw.lastIndexOf(':'))
    : raw
  ).replace(/^\[|\]$/g, '').toLowerCase();
}

const TRUSTED_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Compose sets this to the service name `bridge`. Public hostnames stay rejected. */
export function parseTrustedHosts(raw) {
  const hosts = [];
  for (const part of String(raw || '').split(',')) {
    const host = part.trim().toLowerCase();
    if (!host) continue;
    if (!TRUSTED_HOST_RE.test(host) || host.length > 253) {
      throw new Error(
        `WHATSAPP_TRUSTED_HOSTS entry "${host}" must be a hostname such as bridge.`,
      );
    }
    hosts.push(host);
  }
  return hosts;
}

function selectorsOf(req) {
  return {
    path: String(req.params?.account || '').trim(),
    header: String(req.get?.('x-whatsapp-account') || '').trim(),
    query: String(req.query?.account || '').trim(),
  };
}

export function createBridgeApp({
  accounts,
  defaultName,
  multi,
  scriptHash,
  trustedHosts = [],
  uptime = () => process.uptime(),
}) {
  const byName = new Map(accounts.map((account) => [account.name, account]));
  const names = accounts.map((account) => account.name);
  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...trustedHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean),
  ]);
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const raw = (req.headers.host || '').trim();
    if (!raw) {
      return res.status(400).json({ error: 'Missing Host header' });
    }
    if (!allowedHosts.has(hostOnly(raw))) {
      return res.status(400).json({
        error: 'Invalid Host header. Bridge accepts loopback hosts only.',
      });
    }
    return next();
  });

  function sendJson(res, status, body, account) {
    let payload = body;
    if (
      multi
      && payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && payload.account === undefined
      && !payload.accounts
    ) {
      payload = { ...payload, account: account.name };
    }
    res.status(status).json(payload);
  }

  function resolveAccount(req, res) {
    const selected = selectorsOf(req);
    const present = Object.entries(selected).filter(([, value]) => value);
    const unique = new Set(present.map(([, value]) => value));
    if (unique.size > 1) {
      const selectors = {};
      for (const [key, value] of present) selectors[key] = value;
      res.status(400).json({
        error: 'Conflicting WhatsApp account selectors',
        selectors,
      });
      return null;
    }
    const name = present.length ? present[0][1] : defaultName;
    const account = byName.get(name);
    if (!account) {
      res.status(404).json({
        error: 'Unknown WhatsApp account',
        account: name,
        accounts: names,
      });
      return null;
    }
    return account;
  }

  function legacyHealth(account) {
    const snap = account.healthSnapshot();
    return {
      status: snap.status,
      queueLength: snap.queueLength,
      uptime: uptime(),
      scriptHash,
      sendReadReceipts: snap.sendReadReceipts,
      session: snap.session,
      capabilities: { outboundMentions: true },
    };
  }

  function listEntry(account) {
    const snap = account.healthSnapshot();
    const entry = {
      name: snap.name,
      status: snap.status,
      session: snap.session,
      queueLength: snap.queueLength,
      mode: snap.mode,
    };
    if (snap.linkedUser) entry.linkedUser = snap.linkedUser;
    return entry;
  }

  function register(prefix) {
    app.get(`${prefix}/health`, (req, res) => {
      const selected = selectorsOf(req);
      const anySelector = selected.path || selected.header || selected.query;
      if (!anySelector && multi) {
        const listed = accounts.map(listEntry);
        const body = {
          ...legacyHealth(byName.get(defaultName)),
          multi: true,
          defaultAccount: defaultName,
          allConnected: listed.every((account) => account.status === 'connected'),
          accounts: listed,
        };
        res.json(body);
        return;
      }
      const account = resolveAccount(req, res);
      if (!account) return;
      const body = legacyHealth(account);
      if (multi) {
        const snap = account.healthSnapshot();
        body.account = account.name;
        body.mode = snap.mode;
        if (snap.linkedUser) body.linkedUser = snap.linkedUser;
      }
      res.json(body);
    });

    app.get(`${prefix}/messages`, (req, res) => {
      const account = resolveAccount(req, res);
      if (!account) return;
      res.json(account.drainMessages());
    });

    const connectedRoutes = [
      ['post', '/send', 'send', 'Not connected to WhatsApp', (req) => req.body],
      ['post', '/edit', 'edit', 'Not connected to WhatsApp', (req) => req.body],
      ['post', '/send-media', 'sendMedia', 'Not connected to WhatsApp', (req) => req.body],
      ['post', '/send-poll', 'sendPoll', 'Not connected to WhatsApp', (req) => req.body],
      ['post', '/send-location', 'sendLocation', 'Not connected to WhatsApp', (req) => req.body],
      ['post', '/typing', 'typing', 'Not connected', (req) => req.body],
      ['post', '/read', 'markRead', 'Not connected', (req) => req.body],
    ];
    for (const [method, route, fnName, errorText, argsFor] of connectedRoutes) {
      app[method](`${prefix}${route}`, async (req, res) => {
        const account = resolveAccount(req, res);
        if (!account) return;
        if (account.healthSnapshot().status !== 'connected') {
          sendJson(res, 503, { error: errorText }, account);
          return;
        }
        try {
          const result = await account[fnName](argsFor(req));
          sendJson(res, result.status || 200, result.body, account);
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message || 'Internal error' }, account);
        }
      });
    }

    app.get(`${prefix}/chat/:id`, async (req, res) => {
      const account = resolveAccount(req, res);
      if (!account) return;
      try {
        const result = await account.chatInfo(req.params.id);
        sendJson(res, result.status || 200, result.body, account);
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message || 'Internal error' }, account);
      }
    });

    for (const [route, fnName] of [['/logout', 'logout'], ['/pause', 'pause'], ['/resume', 'resume']]) {
      app.post(`${prefix}${route}`, async (req, res) => {
        const account = resolveAccount(req, res);
        if (!account) return;
        try {
          const result = await account[fnName]();
          sendJson(res, result.status || 200, result.body, account);
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message || 'Internal error' }, account);
        }
      });
    }
  }

  register('');
  register('/accounts/:account');
  return app;
}
