#!/bin/sh
# Fix volume ownership as root, drop to the node user, then start bridge / listener / pair.
# Bare-metal ./start.sh and ./pair.sh do not use this script.
set -eu
umask 077

cd /app
port="${WHATSAPP_BRIDGE_PORT:-3100}"
session="${WHATSAPP_SESSION_DIR:-/app/session}"
mode="${WHATSAPP_MODE:-bot}"

prepare_data_dirs() {
  mkdir -p /app/session /app/sessions /app/listener-data
  chown -R node:node /app/session /app/sessions /app/listener-data
  # Directories only. Do not chmod symlinks (chmod would follow them).
  find /app/session /app/sessions /app/listener-data -type d -exec chmod 700 {} +
  find /app/session /app/sessions /app/listener-data -type f -exec chmod 600 {} +
}

if [ "$(id -u)" = "0" ]; then
  if ! id node >/dev/null 2>&1; then
    echo "Image is missing the node user." >&2
    exit 1
  fi
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "setpriv is missing; cannot drop root." >&2
    exit 1
  fi
  prepare_data_dirs
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$0" "$@"
fi

export HOME="${HOME:-/home/node}"
for dir in /app/session /app/sessions /app/listener-data; do
  if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
    echo "warning: ${dir} is not writable by $(id -un). Start the container as root so the entrypoint can chown session volumes to node (uid $(id -u node 2>/dev/null || echo 1000))." >&2
  fi
done

is_multi() {
  if [ -n "${WHATSAPP_ACCOUNTS:-}" ]; then
    return 0
  fi
  accounts_dir="${WHATSAPP_ACCOUNTS_DIR:-/app/accounts}"
  if [ -d "$accounts_dir" ]; then
    for file in "$accounts_dir"/*.env; do
      if [ -f "$file" ]; then
        return 0
      fi
    done
  fi
  return 1
}

bridge_http() {
  # $1 port  $2 health|pause|resume  $3 account (pause/resume)
  node --input-type=module -e '
    const port = process.argv[1];
    const action = process.argv[2];
    const account = process.argv[3] || "";
    const path = action === "health"
      ? "/health"
      : "/accounts/" + encodeURIComponent(account) + "/" + action;
    fetch("http://127.0.0.1:" + port + path, {
      method: action === "health" ? "GET" : "POST",
      signal: AbortSignal.timeout(4000),
    }).then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));
  ' "$1" "$2" "${3:-}"
}

run_pair() {
  account="${1:-${WHATSAPP_ACCOUNT:-}}"
  if [ "${WHATSAPP_PAIR_CONFIRM:-}" != "1" ]; then
    echo "One-shot pair did not start (WHATSAPP_PAIR_CONFIRM is not 1)." >&2
    echo "First link: docker compose logs -f bridge" >&2
    echo "Re-pair with the bridge stopped:" >&2
    echo "  docker compose stop bridge && docker compose run --rm --no-deps -e WHATSAPP_PAIR_CONFIRM=1 bridge pair ${account}" >&2
    echo "Re-pair one account while the others stay up:" >&2
    echo "  docker compose run --rm -e WHATSAPP_PAIR_CONFIRM=1 pair ${account:-<name>}" >&2
    exit 1
  fi

  if [ -z "$account" ] && is_multi; then
    echo "Multi-account config is on. Pass the account name: pair <name>" >&2
    exit 1
  fi

  if [ -n "$account" ]; then
    paused=0
    if bridge_http "$port" health; then
      if ! bridge_http "$port" pause "$account"; then
        echo "Bridge is up but account \"${account}\" could not be paused. Not pairing." >&2
        exit 1
      fi
      paused=1
      echo "Paused \"${account}\" on the running bridge."
    else
      echo "No bridge is listening on 127.0.0.1:${port} in this network namespace." >&2
      echo "If another container is still running the bridge, stop it before pairing so two processes do not write the same session." >&2
    fi
    set +e
    node bridge.js --port "$port" --mode "$mode" --pair-only --account "$account"
    code=$?
    set -e
    if [ "$paused" -eq 1 ]; then
      if [ "$code" -eq 0 ]; then
        if bridge_http "$port" resume "$account"; then
          echo "Resumed \"${account}\" on the running bridge."
        fi
      else
        echo "Pairing did not finish. Resume with:" >&2
        echo "  docker compose exec bridge node --input-type=module -e 'fetch(\"http://127.0.0.1:${port}/accounts/${account}/resume\",{method:\"POST\"}).then(r=>process.exit(r.ok?0:1))'" >&2
      fi
    fi
    exit "$code"
  fi

  if bridge_http "$port" health; then
    echo "A bridge is already listening on 127.0.0.1:${port}. Scan \`docker compose logs -f bridge\`, or stop the bridge before a one-shot pair." >&2
    exit 1
  fi
  echo "Pairing ${session}. Stop the bridge service first if it is still running." >&2
  exec node bridge.js --port "$port" --session "$session" --mode "$mode" --pair-only
}

if [ "$#" -eq 0 ]; then
  set -- bridge
fi

case "$1" in
  bridge)
    shift
    if is_multi; then
      echo "Starting WhatsApp bridge as $(id -un) on port ${port} (multi-account)."
      exec node bridge.js --port "$port" --mode "$mode"
    fi
    echo "Starting WhatsApp bridge as $(id -un) on port ${port} (session ${session})."
    exec node bridge.js --port "$port" --session "$session" --mode "$mode"
    ;;
  listener)
    shift
    export WHATSAPP_BRIDGE_URL="${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:${port}}"
    export WHATSAPP_INBOX_PATH="${WHATSAPP_INBOX_PATH:-/app/listener-data/inbox.jsonl}"
    export WHATSAPP_LISTENER_STATE_PATH="${WHATSAPP_LISTENER_STATE_PATH:-/app/listener-data/listener-state.json}"
    export WHATSAPP_UNREAD_FLAG_PATH="${WHATSAPP_UNREAD_FLAG_PATH:-/app/listener-data/unread.flag}"
    echo "Starting listener as $(id -un) against ${WHATSAPP_BRIDGE_URL}."
    exec node listener.mjs
    ;;
  pair)
    shift
    run_pair "${1:-}"
    ;;
  *)
    if [ "${WHATSAPP_DOCKER_ROLE:-}" = "pair" ]; then
      run_pair "$1"
    fi
    exec "$@"
    ;;
esac
