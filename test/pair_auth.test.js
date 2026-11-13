import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Executed by the test runner's sandbox. The mock Node never opens a session or socket.
for (const kind of ['bare-metal', 'docker']) {
  test(`${kind} pairing fails closed on authentication and uncertain connectivity failures`, (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-pair-auth-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin); mkdirSync(path.join(dir, 'node_modules'));
    const log = path.join(dir, 'node-calls');
    const script = path.join(dir, 'pair.sh');
    const original = new URL(kind === 'docker' ? '../docker-entrypoint.sh' : '../pair.sh', import.meta.url);
    writeFileSync(script, readFileSync(original, 'utf8').replace('cd /app\n', `cd '${dir}'\n`), { mode: 0o755 });
    writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  *bridge_http_client.mjs)
    printf '%s\\n' "$2" >> "$MOCK_LOG"
    case "$2" in
      health) exit "$MOCK_HEALTH" ;;
      pause) exit "$MOCK_PAUSE" ;;
      resume) exit "$MOCK_RESUME" ;;
      *) exit 0 ;;
    esac ;;
  bridge.js) printf 'pair-session\\n' >> "$MOCK_LOG"; exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u) echo 1000;; *) echo node;; esac\n', { mode: 0o755 });
    for (const { health, pause, resume = '0', account, expected, paired } of [
      { health: '1', pause: '0', account: '', expected: 1, paired: false },
      { health: '1', pause: '0', account: 'primary', expected: 1, paired: false },
      { health: '0', pause: '1', account: 'primary', expected: 1, paired: false },
      { health: '0', pause: '0', account: '', expected: 1, paired: false },
      { health: '2', pause: '0', account: 'primary', expected: 0, paired: true },
      { health: '0', pause: '0', account: 'primary', expected: 0, paired: true },
      { health: '0', pause: '0', resume: '1', account: 'primary', expected: 1, paired: true },
    ]) {
      writeFileSync(log, '');
      const args = kind === 'docker' ? [script, 'pair', account] : [script, account];
      const result = spawnSync(kind === 'docker' ? 'sh' : 'bash', args, {
        cwd: dir, encoding: 'utf8', timeout: 5000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, MOCK_LOG: log,
          MOCK_HEALTH: health, MOCK_PAUSE: pause, MOCK_RESUME: resume, WHATSAPP_PAIR_CONFIRM: '1' },
      });
      assert.equal(result.status, expected, result.stderr + result.stdout);
      const calls = readFileSync(log, 'utf8');
      assert.equal(calls.includes('pair-session'), paired, calls);
      if (paired && health === '0') assert.match(calls, /health\npause\npair-session\nresume/);
      if (health === '1') assert.match(result.stderr, /Cannot safely verify bridge state/);
      if (resume === '1') assert.match(result.stderr, /Pairing completed, but resume failed/);
    }
  });
}
