import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('load_dotenv.py exports quoted values and skips comments', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-dotenv-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, [
    '# comment',
    '',
    'WHATSAPP_BRIDGE_PORT=3100',
    'WHATSAPP_WAKE_WEBHOOK_AUTH="Bearer abc def"',
    "WHATSAPP_ACCOUNTS='[{\"name\":\"ops\"}]'",
  ].join('\n'));
  const result = spawnSync('python3', ['load_dotenv.py', file], { cwd: '/workspace', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /export WHATSAPP_BRIDGE_PORT=3100/);
  assert.match(result.stdout, /export WHATSAPP_WAKE_WEBHOOK_AUTH='Bearer abc def'/);
  assert.doesNotMatch(result.stdout, /comment/);
  rmSync(dir, { recursive: true, force: true });
});
