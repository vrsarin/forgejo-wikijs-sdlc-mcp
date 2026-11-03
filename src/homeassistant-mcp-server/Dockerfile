FROM node:lts-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY src/homeassistant-mcp-server/package.json src/homeassistant-mcp-server/package-lock.json ./
RUN npm ci --ignore-scripts
COPY src/wikijs-sdlc-mcp-server/src/oauth/store.ts ./store.ts
COPY src/shared/tls-http.ts ./tls-http.ts
COPY src/shared/homeassistant-oauth.mjs ./homeassistant-oauth.mjs
COPY src/homeassistant-mcp-server/src/app.mjs src/homeassistant-mcp-server/src/auth.mjs src/homeassistant-mcp-server/src/index.mjs ./src/
RUN ./node_modules/.bin/tsc --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck --outDir compiled store.ts tls-http.ts \
    && cp compiled/store.js ./store.js \
    && cp compiled/tls-http.js ./tls-http.js \
    && ./node_modules/.bin/esbuild src/index.mjs --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js
RUN npm prune --omit=dev --ignore-scripts \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

FROM node:lts-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
WORKDIR /mcp
ENV NODE_ENV=production
# Local modules are bundled into one entry point. JOSE remains visible to
# dependency scanners and resolves from /mcp/node_modules.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/index.js ./index.js
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
ENTRYPOINT ["acme-entrypoint"]
CMD ["node", "/mcp/index.js"]
