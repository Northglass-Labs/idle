# Standalone idle-server: single container, no external dependencies
# Uses PGlite (embedded Postgres), local filesystem storage, no Redis

# Stage 1: build the shared wire package without installing unrelated workspaces.
FROM node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba AS wire-builder

WORKDIR /wire
COPY package.json /workspace-package.json
COPY yarn.lock ./
COPY packages/idle-wire/package.json ./
RUN node -e 'const fs=require("node:fs");const root=JSON.parse(fs.readFileSync("/workspace-package.json","utf8"));const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.resolutions={...root.resolutions,...p.resolutions};fs.writeFileSync("package.json",JSON.stringify(p))'
RUN yarn install --frozen-lockfile --non-interactive
COPY packages/idle-wire ./
RUN yarn build

# Stage 2: build and type-check the relay in an isolated package install.
FROM node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba AS builder

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build

COPY package.json /workspace-package.json
COPY yarn.lock ./
COPY packages/idle-server ./

# The wire package is built locally above and installed explicitly below, so
# the isolated package manager must not try to resolve its unpublished version.
RUN node -e 'const fs=require("node:fs");const root=JSON.parse(fs.readFileSync("/workspace-package.json","utf8"));const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.resolutions={...root.resolutions,...p.resolutions};delete p.devDependencies["@northglass/idle-wire"];fs.writeFileSync("package.json",JSON.stringify(p))'
RUN yarn install --frozen-lockfile --non-interactive

COPY --from=wire-builder /wire/package.json /build/node_modules/@northglass/idle-wire/package.json
COPY --from=wire-builder /wire/dist /build/node_modules/@northglass/idle-wire/dist
RUN yarn build

# Stage 3: install only the relay's production dependencies. Keeping this out
# of the monorepo workspace prevents the mobile/web dependency graph from being
# copied into the production relay image.
FROM node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba AS production-deps

WORKDIR /runtime

COPY package.json /workspace-package.json
COPY yarn.lock ./
COPY packages/idle-server/package.json ./package.json
COPY packages/idle-server/prisma ./prisma

# The server manifest has development-only workspace references that are not
# published packages. Remove only devDependencies in this isolated image stage;
# the frozen root lock still pins every production dependency below.
RUN node -e 'const fs=require("node:fs");const root=JSON.parse(fs.readFileSync("/workspace-package.json","utf8"));const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.resolutions={...root.resolutions,...p.resolutions};delete p.devDependencies;fs.writeFileSync("package.json",JSON.stringify(p))'

RUN yarn install --frozen-lockfile --production --non-interactive --ignore-scripts \
    && yarn cache clean

# The full build stage generated the typed Prisma client. Copy only that output
# into the production dependency tree instead of running code generators (and
# their TypeScript-only toolchain) in the runtime dependency stage.
COPY --from=builder /build/node_modules/.prisma /runtime/node_modules/.prisma
COPY --from=builder /build/node_modules/@prisma/client /runtime/node_modules/@prisma/client

# Stage 4: minimal, non-root runtime
FROM node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba AS runner

WORKDIR /repo

# Prisma's native query engine needs the supported OpenSSL runtime. Keep this
# dependency while leaving unused transfer and media tools out of the image.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# The runtime executes prebuilt JavaScript only. Remove package-manager
# toolchains inherited from the build-oriented Node image so their dependency
# trees are not shipped as an unnecessary attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PGLITE_DIR=/data/pglite
# Container networking requires an all-interface bind inside the namespace;
# the container runtime or platform controls which host interfaces expose it.
ENV HOST=0.0.0.0

RUN install -d -m 0700 -o node -g node /data

COPY --from=production-deps /runtime/node_modules /repo/node_modules
COPY --from=builder /build/dist /repo/packages/idle-server/dist
COPY --from=builder /build/prisma /repo/packages/idle-server/prisma
RUN chmod -R a-w /repo/packages/idle-server/dist /repo/packages/idle-server/prisma

VOLUME /data
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3005/health').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

WORKDIR /repo/packages/idle-server
USER node
CMD ["sh", "-c", "node ./dist/standalone.mjs migrate && exec node ./dist/standalone.mjs serve"]
