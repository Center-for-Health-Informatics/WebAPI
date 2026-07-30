#!/usr/bin/env bash
#
# Build a multi-arch (linux/amd64 + linux/arm64) image and, with PUSH=1, push
# it to the CHI registry.
#
#   ./build.sh              build only, nothing leaves this machine
#   PUSH=1 ./build.sh       build and push to $REGISTRY
#
# Requires a one-time `podman login chi-tools.uc.edu` before pushing.
#
# Note: because of the native better-sqlite3 dependency, the linux/amd64 leg
# runs under QEMU emulation when building on Apple Silicon, so it is
# noticeably slower than the arm64 leg. Set PLATFORMS=linux/arm64 for a quick
# local-only build.
#
# Environment overrides:
#   REGISTRY   registry host           (default chi-tools.uc.edu)
#   PLATFORMS  comma-separated targets (default linux/amd64,linux/arm64)
#   PUSH       set to 1 to push
#   FORCE      set to 1 to allow pushing from a dirty working tree
#
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY=${REGISTRY:-chi-tools.uc.edu}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}

NAME=$(jq -r .name package.json | cut -d/ -f2)
VERSION=$(jq -r .version package.json)
REVISION=$(git rev-parse --short HEAD)
git diff --quiet HEAD -- . || REVISION="${REVISION}-dirty"

IMAGE="${REGISTRY}/${NAME}"

if command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo "build.sh: podman is required for multi-arch builds" >&2
  exit 1
fi

# A manifest list left over from a previous run is added to, not replaced, so
# stale per-arch entries would accumulate. Start clean.
$ENGINE manifest rm "${IMAGE}:${VERSION}" 2>/dev/null || true

# --platform with a comma list plus --manifest builds every leg and assembles
# the image index in one invocation.
$ENGINE build --pull=newer \
  --platform "$PLATFORMS" \
  --manifest "${IMAGE}:${VERSION}" \
  --build-arg VERSION="$VERSION" \
  --build-arg REVISION="$REVISION" \
  --build-arg CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .

# Tagging a manifest list gives the same list another name, so all three tags
# stay multi-arch.
$ENGINE tag "${IMAGE}:${VERSION}" "${IMAGE}:${VERSION}-g${REVISION}" "${IMAGE}:latest"

echo
echo "built ${IMAGE}:${VERSION}"
echo "       ${IMAGE}:${VERSION}-g${REVISION}"
echo "       ${IMAGE}:latest"

if [[ ${PUSH:-0} != 1 ]]; then
  echo
  echo "not pushed (set PUSH=1 to push to ${REGISTRY})"
  exit 0
fi

if [[ "$REVISION" == *-dirty && ${FORCE:-0} != 1 ]]; then
  echo >&2
  echo "build.sh: refusing to push a build from a dirty working tree." >&2
  echo "          Commit first, or set FORCE=1 to override." >&2
  exit 1
fi

# --all is required: without it only the index is pushed and the per-arch
# manifests it references can be missing from the registry.
for TAG in "${VERSION}" "${VERSION}-g${REVISION}" latest; do
  echo "pushing ${IMAGE}:${TAG}"
  $ENGINE manifest push --all "${IMAGE}:${VERSION}" "docker://${IMAGE}:${TAG}"
done
