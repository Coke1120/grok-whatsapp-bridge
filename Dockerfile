# Node 22: @whiskeysockets/baileys declares engines.node >= 20.
# Bookworm (glibc) matches the Debian builds of optional native addons such as sharp.
# WHATSAPP_BIND_HOST=0.0.0.0 is for container bridge networking. Compose publishes
# 127.0.0.1 only. Bare metal does not use this image env and stays on 127.0.0.1.
# The entrypoint starts as root so it can chown session volumes, then drops to node.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/node \
    WHATSAPP_BRIDGE_PORT=37100 \
    WHATSAPP_MODE=bot \
    WHATSAPP_SESSION_DIR=/app/session \
    WHATSAPP_BIND_HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY account_http.js account_runtime.js accounts_config.js allowlist.js \
     bridge.js bridge_helpers.js bridge_startup.js listener.mjs \
     outbound_ids.js owner_message_gate.js ./
COPY accounts ./accounts
COPY accounts.example.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && command -v setpriv >/dev/null \
    && id node >/dev/null \
    && mkdir -p /app/session /app/sessions /app/listener-data \
    && chown -R node:node /app/session /app/sessions /app/listener-data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.WHATSAPP_BRIDGE_PORT||'37100';fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bridge"]
