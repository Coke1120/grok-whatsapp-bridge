import { createHash, timingSafeEqual } from 'node:crypto';

const INVALID_TOKEN_CHAR = /[^A-Za-z0-9_-]/;
const CONFIG_ERROR = 'WHATSAPP_API_TOKEN must be a 32–256 character URL-safe token.';

// Deliberately no insecure default, query-token fallback or reflected token value.
export function requireApiToken(raw) {
  if (typeof raw !== 'string' || raw.length < 32 || raw.length > 256 || INVALID_TOKEN_CHAR.test(raw)) throw new Error(CONFIG_ERROR);
  return raw;
}

export function bridgeAuthorizationHeaders(raw) {
  return { Authorization: `Bearer ${requireApiToken(raw)}` };
}

export function createApiAuthenticator(raw) {
  const token = requireApiToken(raw);
  const digest = (value) => createHash('sha256').update(value).digest();
  const expected = digest(token);
  return (req) => {
    const headerCount = (req.rawHeaders || []).filter((_, i, headers) =>
      i % 2 === 0 && headers[i].toLowerCase() === 'authorization').length;
    if (headerCount !== 1) return false;
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(req.headers.authorization || '');
    return !!match && timingSafeEqual(digest(match[1]), expected);
  };
}
