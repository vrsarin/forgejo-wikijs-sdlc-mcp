FROM node:lts-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build

WORKDIR /app/forgejo-mcp-server
COPY src/forgejo-mcp-server/package.json src/forgejo-mcp-server/package-lock.json src/forgejo-mcp-server/tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/shared/discovery-access.ts src/shared/login-flow.ts src/shared/tls-http.ts /app/shared/
COPY src/forgejo-mcp-server/src ./src
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

FROM node:lts-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
ENV NODE_ENV=production
WORKDIR /mcp
# Local modules are bundled into one entry point. External production packages
# remain visible to dependency scanners and resolve from /mcp/node_modules.
COPY --from=build --chown=node:node /app/forgejo-mcp-server/package.json ./package.json
COPY --from=build --chown=node:node /app/forgejo-mcp-server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/forgejo-mcp-server/dist/index.js ./index.js
COPY src/shared/acme-entrypoint.sh /usr/local/bin/acme-entrypoint
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "const p=process.env.ENABLE_TLS==='true'?'https':'http';require(p).get(p+'://127.0.0.1:3000/healthz',{rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["acme-entrypoint"]
CMD ["node", "/mcp/index.js"]
