# A16: one image for both services, and no bind mount in compose.
#
# The previous design mounted the repository into the container and ran
# `pnpm install` there. That wrote root-owned node_modules for every workspace
# package, plus a root-owned `.pnpm-store` of about 650 MB, into whoever ran
# `docker compose up` — measured 13744 root-owned paths in a clean copy on
# 2026-11-03, undeletable without sudo because the directories sit inside a tree
# the user owns. Installing into the image instead keeps the checkout clean.
#
# Dev servers, not production builds: the point of `docker compose up` here is
# DQ-1, a fresh clone with no keys reaching a running api and dashboard.
FROM node:22-alpine

# Root, deliberately: the dev servers write into /app (`.next`, tsx caches) and
# nothing from this image is mounted back onto a host, so container-internal
# ownership is all it ever touches.
RUN corepack enable

WORKDIR /app

# Manifests first so a source-only edit does not re-resolve the dependency graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 3000 3001

CMD ["sh", "-c", "pnpm --filter @till/api dev"]
