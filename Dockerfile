FROM node:lts-slim

# Unlike Atlas, this stage is deliberately NOT pinned to $BUILDPLATFORM:
# better-sqlite3 is a native module, so node_modules is architecture-specific
# and must be installed for the *target* platform. Cross-building linux/amd64
# from an arm64 Mac therefore runs this image under QEMU emulation -- see
# build.sh.

WORKDIR /app

# One apt layer for both the runtime JRE (needed by lib/circe.jar) and the
# node-gyp toolchain. python3/make/g++ are only a fallback for when
# better-sqlite3 has no prebuilt binary for the target platform; they are
# purged again so they never ship in the image. Kept as a single RUN because
# an extra `apt-get update` is disproportionately slow under emulation.
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        default-jre-headless python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY src/ ./src/
COPY migrations/ ./migrations/
COPY lib/circe.jar ./lib/circe.jar

ENV NODE_ENV=production

# Supplied by build.sh so a deployed image can be traced back to a commit.
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=

LABEL org.opencontainers.image.title="CHI-WebAPI"
LABEL org.opencontainers.image.description="Node.js drop-in replacement for OHDSI WebAPI"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="$VERSION"
LABEL org.opencontainers.image.revision="$REVISION"
LABEL org.opencontainers.image.created="$CREATED"

# Documentation only, and only accurate for the default: the actual listen port
# is EXPRESS_PORT (src/config.js, default 80), which the compose file maps to
# HTTP_PORT on the host.
EXPOSE 80

CMD ["node", "src/server.js"]
