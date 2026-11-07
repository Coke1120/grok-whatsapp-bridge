import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// The event ledger and pending deliveries are committed together. Never persist
// webhook URLs or bearer credentials: those come only from current configuration.
export function saveListenerState(filePath, state) {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filePath);
    // Best effort on platforms that do not support fsync on a directory.
    let dir;
    try { dir = openSync(path.dirname(filePath), 'r'); fsyncSync(dir); }
    catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error; }
    finally { if (dir !== undefined) closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const webhookDestination = (target) => hash([target.wakeUrl, target.wakeAuth]);
export const deliveryIdentity = (account, chatId, rawId) => `wa-${hash([account, chatId, rawId])}`;
export const retryableWebhookStatus = (status) => [408, 425, 429].includes(status) || status >= 500;
export const WAKE_RETRY_DELAYS = [5000, 30000, 120000, 600000];

export function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Listener option must be an integer in ${min}..${max}`);
  }
  return number;
}
