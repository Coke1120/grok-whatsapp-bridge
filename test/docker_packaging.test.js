import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(name) {
  return readFileSync(path.join(root, name), 'utf8');
}

test('docker entrypoint is valid POSIX sh', () => {
  const result = spawnSync('sh', ['-n', 'docker-entrypoint.sh'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('dockerignore keeps secrets and sessions out of the build context', () => {
  const ignored = read('.dockerignore');
  for (const line of ['.env', 'session', 'sessions', 'accounts/*.env', 'accounts.json']) {
    assert.ok(ignored.split('\n').includes(line), line);
  }
});

test('compose publishes loopback, persists sessions, and keeps the listener optional', () => {
  const result = spawnSync('python3', ['-c', `
import yaml
with open("docker-compose.yml") as fh:
    data = yaml.safe_load(fh)
bridge = data["services"]["bridge"]
listener = data["services"]["listener"]
pair = data["services"]["pair"]
port = bridge["ports"][0]
assert port.startswith("127.0.0.1:"), port
assert "0.0.0.0:" not in port
assert bridge["restart"] == "unless-stopped"
assert bridge["env_file"] == ".env"
assert bridge["environment"]["WHATSAPP_BIND_HOST"] == "0.0.0.0"
assert bridge["environment"]["WHATSAPP_TRUSTED_HOSTS"] == "bridge"
assert bridge["environment"]["WHATSAPP_SESSION_DIR"] == "/app/session"
assert "/health" in " ".join(bridge["healthcheck"]["test"])
assert "wa-session:/app/session" in bridge["volumes"]
assert "wa-sessions:/app/sessions" in bridge["volumes"]
assert listener["profiles"] == ["listener"]
assert listener["restart"] == "unless-stopped"
assert "network_mode" not in listener
assert listener["command"] == ["listener"]
assert listener["environment"]["WHATSAPP_BRIDGE_URL"].startswith("http://bridge:")
assert listener["environment"]["WHATSAPP_INBOX_PATH"] == "/app/listener-data/inbox.jsonl"
assert "wa-listener:/app/listener-data" in listener["volumes"]
assert pair["profiles"] == ["pair"]
assert pair["restart"] == "no"
assert pair["network_mode"] == "service:bridge"
assert set(data["volumes"]) == {"wa-session", "wa-sessions", "wa-listener"}
print("ok")
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test('unset bridge HTTP port defaults to 37100', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /127\.0\.0\.1:\$\{WHATSAPP_BRIDGE_PORT:-37100\}:\$\{WHATSAPP_BRIDGE_PORT:-37100\}/);
  assert.match(compose, /http:\/\/bridge:\$\{WHATSAPP_BRIDGE_PORT:-37100\}/);
  assert.match(compose, /WHATSAPP_BRIDGE_PORT\|\|'37100'/);
  assert.doesNotMatch(compose, /3100/);

  const docker = read('Dockerfile');
  assert.match(docker, /WHATSAPP_BRIDGE_PORT=37100/);
  assert.match(docker, /WHATSAPP_BRIDGE_PORT\|\|'37100'/);
  assert.doesNotMatch(docker, /3100/);

  for (const name of [
    'docker-entrypoint.sh',
    'start.sh',
    'pair.sh',
    'logout.sh',
    'start-listener.sh',
    '.env.example',
    'listener.mjs',
    'bridge.js',
  ]) {
    const text = read(name);
    assert.match(text, /37100/, name);
    assert.doesNotMatch(text, /3100/, name);
  }
});

test('Dockerfile is a Node 22 multi-stage image that healthchecks /health', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /FROM node:22-bookworm-slim AS deps/);
  assert.match(docker, /FROM node:22-bookworm-slim AS runtime/);
  assert.match(docker, /npm ci --omit=dev/);
  assert.match(docker, /setpriv/);
  assert.match(docker, /\/health/);
  assert.doesNotMatch(docker, /^EXPOSE /m);
  assert.match(docker, /ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]/);
  assert.match(docker, /CMD \["bridge"\]/);
});
