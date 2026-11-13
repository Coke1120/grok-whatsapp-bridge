import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
assert bridge["image"] == "ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.3"
assert listener["image"] == bridge["image"]
assert pair["image"] == bridge["image"]
assert "build" not in listener and "build" not in pair
assert bridge["environment"]["WHATSAPP_BIND_HOST"] == "0.0.0.0"
assert bridge["environment"]["WHATSAPP_TRUSTED_HOSTS"] == "\${WHATSAPP_TRUSTED_HOSTS:-bridge}"
assert bridge["environment"]["WHATSAPP_SESSION_DIR"] == "/app/session"
assert bridge["healthcheck"]["test"][:3] == ["CMD", "node", "-e"]
health = bridge["healthcheck"]["test"][3]
assert "process.env.WHATSAPP_API_TOKEN" in health
assert "Authorization:" in health and "redirect:'error'" in health
assert "AbortSignal.timeout(4000)" in health
assert "/health" in health
assert bridge["environment"]["WHATSAPP_API_TOKEN"] == "\${WHATSAPP_API_TOKEN:-}"
assert listener["environment"]["WHATSAPP_API_TOKEN"] == bridge["environment"]["WHATSAPP_API_TOKEN"]
assert pair["environment"]["WHATSAPP_API_TOKEN"] == bridge["environment"]["WHATSAPP_API_TOKEN"]
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
  assert.match(read('bridge_http_client.mjs'), /WHATSAPP_BRIDGE_PORT \|\| '37100'/);
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
  assert.match(readme, /ghcr\.io\/coke1120\/grok-whatsapp-bridge:v1\.3\.3/);
  assert.match(readme, /do not use Tailscale Funnel/i);
});

test('Dockerfile is a Node 22 multi-stage image that healthchecks /health', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /FROM node:22-bookworm-slim AS deps/);
  assert.match(docker, /FROM node:22-bookworm-slim AS runtime/);
  const stages = docker.split(/^FROM /m).slice(1);
  assert.equal(stages.length, 2);
  for (const stage of stages) {
    const beforeCopy = stage.split(/^COPY /m)[0];
    assert.match(beforeCopy, /apt-get update/);
    assert.match(beforeCopy, /apt-get install -y --no-install-recommends ca-certificates/);
    assert.match(beforeCopy, /update-ca-certificates/);
    assert.match(beforeCopy, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  }
  assert.match(docker, /npm ci --omit=dev/);
  assert.match(docker, /setpriv/);
  assert.match(docker, /bridge_http_client\.mjs.*, \"health\"/);
  assert.doesNotMatch(docker, /^EXPOSE /m);
  assert.match(docker, /ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]/);
  assert.match(docker, /CMD \["bridge"\]/);
});

test('Docker image includes MCP and the durable listener delivery helper', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /^COPY mcp \.\/mcp$/m);
  assert.match(docker, /listener\.mjs listener_delivery\.mjs/);
  assert.match(docker, /COPY access_scopes\.js/);
});

test('MCP overlay builds current source and confines stdio without session access', () => {
  const result = spawnSync('python3', ['-c', `
import yaml
with open("docker-compose.yml") as fh:
    base = yaml.safe_load(fh)
with open("docker-compose.mcp.yml") as fh:
    overlay = yaml.safe_load(fh)
services = overlay["services"]
for role in ["bridge", "listener", "pair", "mcp"]:
    service = services[role]
    assert service["build"] == ".", (role, service)
    assert service["image"] == "grok-whatsapp-bridge:mcp-local", role
    assert service["image"] != base["services"]["bridge"]["image"], role
    assert service["pull_policy"] == "never", role
mcp = services["mcp"]
assert mcp["profiles"] == ["mcp"]
assert mcp["command"] == ["mcp"]
assert mcp["stdin_open"] is True
assert mcp["tty"] is False
assert mcp["user"] == "node"
assert mcp["read_only"] is True
assert mcp["cap_drop"] == ["ALL"]
assert mcp["security_opt"] == ["no-new-privileges:true"]
assert mcp["restart"] == "no"
assert mcp["network_mode"] == "service:bridge"
assert mcp["depends_on"] == {"bridge": {"condition": "service_healthy"}}
assert "ports" not in mcp and "expose" not in mcp
assert not any(key in mcp for key in ["privileged", "devices", "env_file", "pid"])
assert mcp["volumes"] == [{
    "type": "volume", "source": "wa-listener", "target": "/app/listener-data", "read_only": True,
}]
env = mcp["environment"]
assert env["WHATSAPP_API_TOKEN"] == base["services"]["bridge"]["environment"]["WHATSAPP_API_TOKEN"]
assert env["WHATSAPP_BRIDGE_URL"] == "http://127.0.0.1:\${WHATSAPP_BRIDGE_PORT:-37100}"
assert env["WHATSAPP_INBOX_PATH"] == "/app/listener-data/inbox.jsonl"
assert env["WHATSAPP_MCP_ALLOWED_CHATS"] == "\${WHATSAPP_MCP_ALLOWED_CHATS:-}"
assert env["WHATSAPP_SCOPES"] == "\${WHATSAPP_SCOPES:-}"
assert base["services"]["bridge"]["environment"]["WHATSAPP_SCOPES"] == env["WHATSAPP_SCOPES"]
assert base["services"]["listener"]["environment"]["WHATSAPP_SCOPES"] == env["WHATSAPP_SCOPES"]
assert env["WHATSAPP_MCP_SEND_ENABLED"] == "\${WHATSAPP_MCP_SEND_ENABLED:-0}"
assert env["WHATSAPP_MCP_ALLOW_GROUPS"] == "\${WHATSAPP_MCP_ALLOW_GROUPS:-0}"
assert env["WHATSAPP_MCP_ALLOW_REMOTE"] == "0"
assert set(env) == {
    "HOME", "WHATSAPP_API_TOKEN", "WHATSAPP_BRIDGE_URL", "WHATSAPP_INBOX_PATH", "WHATSAPP_MCP_ALLOWED_CHATS",
    "WHATSAPP_MCP_SEND_ENABLED", "WHATSAPP_MCP_ALLOW_GROUPS", "WHATSAPP_MCP_ALLOW_REMOTE", "WHATSAPP_SCOPES",
}
assert mcp["healthcheck"] == {"disable": True}
assert mcp["logging"] == {"driver": "none"}
print("ok")
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Compose passes opt-in listener delivery retry configuration', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /WHATSAPP_WAKE_RETRY_ENABLED: \$\{WHATSAPP_WAKE_RETRY_ENABLED:-0\}/);
  assert.match(compose, /WHATSAPP_WAKE_TIMEOUT_MS: \$\{WHATSAPP_WAKE_TIMEOUT_MS:-5000\}/);
  assert.match(compose, /WHATSAPP_WAKE_MAX_ATTEMPTS: \$\{WHATSAPP_WAKE_MAX_ATTEMPTS:-5\}/);
});

test('PR CI builds both architectures and runs bounded, isolated MCP containers without publishing', () => {
  const result = spawnSync('python3', ['-c', `
import ast, subprocess, yaml
with open(".github/workflows/test.yml") as fh:
    workflow = yaml.safe_load(fh)
triggers = workflow.get("on", workflow.get(True))
assert triggers == {"pull_request": {"branches": ["dev", "main"]}, "push": {"branches": ["dev"]}}
assert workflow["permissions"] == {"contents": "read"}
job = workflow["jobs"]["docker-mcp"]
assert job["if"] == "github.event_name == 'pull_request'"
assert job["needs"] == "node" and job["timeout-minutes"] <= 35
assert job["strategy"]["matrix"]["include"] == [
    {"platform": "linux/amd64", "node_arch": "x64"}, {"platform": "linux/arm64", "node_arch": "arm64"},
]
steps = job["steps"]
assert any(s.get("uses", "").startswith("docker/setup-qemu-action@") for s in steps)
assert any(s.get("uses", "").startswith("docker/setup-buildx-action@") for s in steps)
build = next(s["with"] for s in steps if s.get("uses", "").startswith("docker/build-push-action@"))
assert build["push"] is False and build["load"] is True
assert not any("login-action" in s.get("uses", "") for s in steps)
config = next(s["run"] for s in steps if s.get("name") == "Validate merged MCP configuration")
assert all("--profile " + profile in config for profile in ["mcp", "listener", "pair"])
smoke = next(s for s in steps if s.get("name") == "Run isolated, non-root, read-only stdio smoke")
assert smoke["timeout-minutes"] <= 3
for step in steps:
    if "run" not in step:
        continue
    result = subprocess.run(["bash", "-n"], input=step["run"], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    if "<<'PY'\\n" in step["run"]:
        body = step["run"].split("<<'PY'\\n", 1)[1].rsplit("\\nPY", 1)[0]
        tree = ast.parse(body)
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "guard" for t in node.targets):
                result = subprocess.run(["node", "--check"], input=ast.literal_eval(node.value), text=True, capture_output=True)
                assert result.returncode == 0, result.stderr
for flag in ["--network", "--read-only", "--user", "--cap-drop", "--no-healthcheck"]:
    assert flag in smoke["run"], flag
assert '"none"' in smoke["run"] and '"node"' in smoke["run"]
assert '"WHATSAPP_MCP_SEND_ENABLED=0"' in smoke["run"]
assert 'timeout=60' in smoke["run"]
print("ok")
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// Docker is not required for these executable entrypoint tests. Only identity,
// setpriv and the /app working directory are substituted; the real MCP server
// and Node stdio are exercised. Real container hardening is checked separately.
for (const uid of ['0', '1000']) {
  test(`MCP entrypoint is protocol-only and never prepares data directories (uid ${uid})`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'whatsapp-docker-mcp-'));
    try {
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      const script = path.join(dir, 'entrypoint.sh');
      writeFileSync(script, read('docker-entrypoint.sh').replace('cd /app\n', `cd '${dir}'\n`), { mode: 0o755 });
      symlinkSync(path.join(root, 'mcp'), path.join(dir, 'mcp'), 'dir');
      symlinkSync(process.execPath, path.join(bin, 'node'));
      writeFileSync(path.join(bin, 'id'), `#!/bin/sh
case "$1" in
  -u) printf '%s\\n' "$MOCK_UID" ;;
  -un) printf 'node\\n' ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
      writeFileSync(path.join(bin, 'setpriv'), `#!/bin/sh
printf '%s\\n' "$@" > "$MCP_TEST_PRIV_LOG"
while [ "\${1#--}" != "$1" ]; do shift; done
export MOCK_UID=1000
exec "$@"
`, { mode: 0o755 });
      for (const command of ['mkdir', 'chown', 'chmod', 'find']) {
        writeFileSync(path.join(bin, command), `#!/bin/sh
echo 'MCP must not prepare data directories: ${command}' >&2
exit 91
`, { mode: 0o755 });
      }
      const log = path.join(dir, 'privileges.log');
      const input = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      ].map((message) => JSON.stringify(message)).join('\n') + '\n';
      const result = spawnSync('sh', [script, 'mcp'], {
        cwd: root, encoding: 'utf8', input, timeout: 5000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/node', MOCK_UID: uid, MCP_TEST_PRIV_LOG: log },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(replies.length, 3);
      assert.deepEqual(new Set(replies.map((reply) => reply.id)), new Set([1, 2, 3]));
      assert.ok(replies.every((reply) => reply.jsonrpc === '2.0' && reply.result && !reply.error));
      assert.ok(replies.find((reply) => reply.id === 3).result.tools.length > 0);
      if (uid === '0') {
        assert.match(readFileSync(log, 'utf8'), /--reuid=node\n--regid=node\n--init-groups\n--inh-caps=-all\n/);
      } else {
        assert.equal(existsSync(log), false, 'non-root MCP must not invoke setpriv');
        const pairResult = spawnSync('sh', [script, 'mcp'], {
          cwd: root, encoding: 'utf8', timeout: 5000,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/node', MOCK_UID: uid, WHATSAPP_DOCKER_ROLE: 'pair' },
        });
        assert.equal(pairResult.status, 1);
        assert.equal(pairResult.stdout, '');
        assert.match(pairResult.stderr, /One-shot pair did not start/,
          'an existing account named mcp must retain the pair confirmation guard');
      }
      for (const name of ['session', 'sessions', 'listener-data']) {
        assert.equal(existsSync(path.join(dir, name)), false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
