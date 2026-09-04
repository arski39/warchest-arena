# Use an official Node runtime as the base image
FROM node:24-slim AS base
WORKDIR /usr/src/app

# Build stage - install ALL dependencies and build
FROM base AS build
ENV HUSKY=0
# Copy package files first for better caching
COPY package*.json ./
# --ignore-scripts, matching `npm run inst`. Not a hardening flourish:
# `canvas` is a devDependency with an install script (prebuild-install ||
# node-gyp rebuild) and node-canvas publishes no linux-arm64 prebuild, so on
# the ARM box plain `npm ci` drops into node-gyp and dies -- node:24-slim has
# no python3, make, g++ or cairo/pango headers. Nothing under src/ imports
# canvas; its only consumer is tests/setup.ts, and tests/ is in .dockerignore.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

# Copy only what's needed for build
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY eslint.config.js ./
COPY index.html ./
COPY resources ./resources
COPY proprietary ./proprietary
COPY src ./src
# build-prod runs scripts/buildAssetHashes.ts after vite, to emit
# static/asset-hashes.json and static/core-version.txt for the desktop
# release descriptor. Without this the image build fails at that step with
# ERR_MODULE_NOT_FOUND -- the unit suite cannot catch it, because only the
# container build runs build-prod from a copied tree.
COPY scripts ./scripts

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT="$GIT_COMMIT"
RUN npm run build-prod

# Production dependencies stage - separate from build
FROM base AS prod-deps
ENV HUSKY=0
ENV NPM_CONFIG_IGNORE_SCRIPTS=1
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Final production image
FROM base

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nginx \
    curl \
    wget \
    supervisor \
    apache2-utils \
    && rm -rf /var/lib/apt/lists/*

# Update worker_connections in nginx.conf
RUN sed -i 's/worker_connections [0-9]*/worker_connections 8192/' /etc/nginx/nginx.conf

# Setup supervisor configuration
RUN mkdir -p /var/log/supervisor
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

# Script that generates the create-game worker upstream at container start.
COPY generate-nginx-upstream.sh /usr/local/bin/generate-nginx-upstream.sh
RUN chmod +x /usr/local/bin/generate-nginx-upstream.sh

# Copy production node_modules from prod-deps stage (cached separately from build)
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY package*.json ./

# Copy built artifacts from build stage
COPY --from=build /usr/src/app/static ./static

COPY resources ./resources

# Remove the plain map directory: `npm run build-prod` already emitted a
# content-hashed copy of every file in it under static/_assets/maps (both
# trees are 499 MB), so shipping both would put ~1 GB of duplicated map data
# in the image.
#
# The server DOES need this data -- Phase 4 replays a wagered match to derive
# its winner -- so NodeMapLoader resolves through static/asset-manifest.json
# whenever resources/maps is absent. Upstream's comment here said the maps
# were "not used by the server", which stopped being true when Phase 4
# landed; with the loader reading a directory that is not in the image, every
# wagered match failed verification and refunded on the escrow's 24 h timeout
# instead of paying out. Do not delete static/_assets/maps, and do not
# restore this directory expecting the loader to need it.
RUN rm -rf ./resources/maps
COPY tsconfig.json ./
COPY src ./src


ARG GIT_COMMIT=unknown
RUN echo "$GIT_COMMIT" > static/commit.txt

ENV GIT_COMMIT="$GIT_COMMIT"

RUN <<'EOF' tee /usr/local/bin/start.sh
#!/bin/sh
# Generate the create-game nginx upstream from NUM_WORKERS before nginx starts.
/usr/local/bin/generate-nginx-upstream.sh

if [ "$DOMAIN" = openfront.dev ] && [ "$SUBDOMAIN" != main ]; then
    exec timeout 25h /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
else
    exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
fi
EOF
RUN chmod +x /usr/local/bin/start.sh
ENTRYPOINT ["/usr/local/bin/start.sh"]
