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
assert "env_file" not in bridge
assert "build" not in bridge
assert "network_mode" not in bridge
assert bridge["image"] == "ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.1"
assert listener["image"] == bridge["image"]
assert pair["image"] == bridge["image"]
assert "build" not in listener and "build" not in pair
assert bridge["environment"]["WHATSAPP_BIND_HOST"] == "0.0.0.0"
assert bridge["environment"]["WHATSAPP_TRUSTED_HOSTS"] == "\${WHATSAPP_TRUSTED_HOSTS:-bridge}"
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
  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.doesNotMatch(compose, /^\s*env_file:/m);
  assert.doesNotMatch(compose, /network_mode:\s*["']?host/);

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

test('NAS compose pulls GHCR and does not build; host network is opt-in', () => {
  const host = read('docker-compose.host-net.yml');
  assert.match(host, /network_mode:\s*host/);
  assert.match(host, /WHATSAPP_BIND_HOST:\s*"127\.0\.0\.1"/);
  assert.match(host, /ports:\s*!reset/);
  assert.match(host, /http:\/\/127\.0\.0\.1:/);
  const hostCode = host.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(hostCode, /0\.0\.0\.0:37100/);
  assert.doesNotMatch(hostCode, /build:/);

  const devBuild = read('docker-compose.build.yml');
  assert.match(devBuild, /build:\s*\./);
  assert.match(devBuild, /Synology and Portainer must not use this file/);

  const workflow = read('.github/workflows/publish-image.yml');
  assert.match(workflow, /linux\/amd64/);
  assert.match(workflow, /linux\/arm64/);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /ghcr\.io\/coke1120\/grok-whatsapp-bridge/);
  assert.match(workflow, /provenance:\s*false/);
  assert.doesNotMatch(workflow, /upload-artifact|action-gh-release|softprops/);

  const doc = read('docs/docker-synology.md');
  assert.match(doc, /EAI_AGAIN/);
  assert.match(doc, /leohofamily\.tail48056\.ts\.net/);
  assert.match(doc, /Funnel/);
  assert.match(doc, /HTTPS 200 is not WSS/);
  assert.match(doc, /do not build|Do not build|never run/i);
  const readme = read('README.md');
  assert.match(readme, /ghcr\.io\/coke1120\/grok-whatsapp-bridge:v1\.3\.1/);
  assert.match(readme, /do not use Tailscale Funnel/i);
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
