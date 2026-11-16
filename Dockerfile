FROM node:lts-alpine3.24@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

FROM node:lts-alpine3.24@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS runtime
ENV NODE_ENV=production
WORKDIR /mcp
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/index.js ./index.js
COPY src/core/acme-entrypoint.sh /usr/local/bin/acme-entrypoint
RUN apk add --no-cache certbot \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && chmod 0755 /usr/local/bin/acme-entrypoint \
    && mkdir /data \
    && chown node:node /data \
    && chmod 0700 /data
VOLUME /data
USER node:node
EXPOSE 3000 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "const e=process.env,t=e.ENABLE_TLS==='true'||(e.ENABLE_TLS===undefined&&e.MCP_TLS_CERT_PATH&&e.MCP_TLS_KEY_PATH),p=t?'https':'http';require(p).get(p+'://127.0.0.1:'+(e.MCP_PORT||3000)+'/healthz',{rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["acme-entrypoint"]
CMD ["node", "/mcp/index.js"]
