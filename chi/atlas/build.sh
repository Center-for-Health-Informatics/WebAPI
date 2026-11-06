#!/usr/bin/env bash
#
# Build the CHI Atlas3 image (linux/amd64 + linux/arm64) with Apple's
# `container` tool and, with PUSH=1, push it to the CHI registry. chi-cetus
# only ever pulls.
#
#   chi/atlas/build.sh              build only
#   PUSH=1 chi/atlas/build.sh       build, scan, and push to $REGISTRY
#
# Atlas3 is built from ATLAS_SRC (default ~/Projects/Atlas3, whatever branch
# is checked out) with `npm ci && npm run build`, then served by nginx.
# The version is chi/atlas/CHI_VERSION (e.g. 3.0.1-chi.1): bump it for every
# image you push; tags are never reused. Setup as for ../../build.sh.
#
# Environment overrides: REGISTRY, PLATFORMS, PUSH, FORCE (push from a dirty
# tree), ATLAS_SRC, SKIP_NPM (reuse ATLAS_SRC/dist; never with PUSH=1).
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD

REGISTRY=${REGISTRY:-chi-tools.uc.edu}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}
ATLAS_SRC=${ATLAS_SRC:-$HOME/Projects/Atlas3}
NAME=atlas3
PUSH=${PUSH:-0}

die() { echo "build.sh: $*" >&2; exit 1; }

VERSION=$(tr -d '[:space:]' < CHI_VERSION)
REVISION=$(git rev-parse --short HEAD)
git diff --quiet HEAD -- . || REVISION="${REVISION}-dirty"
ATLAS_REVISION=$(git -C "$ATLAS_SRC" rev-parse --short HEAD)
[[ -z $(git -C "$ATLAS_SRC" status --porcelain) ]] || ATLAS_REVISION="${ATLAS_REVISION}-dirty"
ATLAS_BRANCH=$(git -C "$ATLAS_SRC" rev-parse --abbrev-ref HEAD)

IMAGE="${REGISTRY}/${NAME}"
TAGS=("${VERSION}" "${VERSION}-a${ATLAS_REVISION%-dirty}" latest)

command -v container >/dev/null 2>&1 || die "Apple's container tool is required"
container system status >/dev/null 2>&1 || die "container system is not running (container system start)"

if [[ $PUSH == 1 ]]; then
  [[ ( "$REVISION" != *-dirty && "$ATLAS_REVISION" != *-dirty ) || ${FORCE:-0} == 1 ]] ||
    die "refusing to push from a dirty working tree (this repo or ${ATLAS_SRC}). Commit first, or set FORCE=1."
  [[ ${SKIP_NPM:-0} != 1 ]] || die "SKIP_NPM is not allowed with PUSH=1"
  for t in trivy syft skopeo; do command -v $t >/dev/null 2>&1 || die "$t is required to push"; done
  if out=$(skopeo inspect --raw "docker://${IMAGE}:${VERSION}" 2>&1); then
    die "${IMAGE}:${VERSION} already exists in the registry. Bump chi/atlas/CHI_VERSION."
  elif ! grep -qiE 'manifest unknown|not found' <<<"$out"; then
    die "could not check ${IMAGE}:${VERSION} in the registry: ${out}"
  fi
fi

if [[ ${SKIP_NPM:-0} != 1 ]]; then
  echo "building Atlas3 ${ATLAS_BRANCH} @ ${ATLAS_REVISION}"
  (cd "$ATLAS_SRC" && npm ci --no-audit --no-fund && npm run build)
fi

# Build context: this directory's files plus a copy of the dist.
CTX="${HERE}/../../build/atlas-context"
rm -rf "$CTX" && mkdir -p "$CTX"
cp Dockerfile nginx.conf config-local.json plugins.json "$CTX/"
cp -R "${ATLAS_SRC}/dist" "$CTX/dist"
rm -f "$CTX/dist/config-local.json"

PLATFORM_ARGS=()
IFS=, read -ra PLATFORM_LIST <<<"$PLATFORMS"
for p in "${PLATFORM_LIST[@]}"; do PLATFORM_ARGS+=(--platform "$p"); done

container build "${PLATFORM_ARGS[@]}" -t "${IMAGE}:${VERSION}" \
  --build-arg VERSION="$VERSION" --build-arg REVISION="$REVISION" \
  --build-arg ATLAS_REVISION="$ATLAS_REVISION" \
  --build-arg CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$CTX"
for TAG in "${TAGS[@]:1}"; do container image tag "${IMAGE}:${VERSION}" "${IMAGE}:${TAG}"; done
echo; for TAG in "${TAGS[@]}"; do echo "built ${IMAGE}:${TAG}"; done

if [[ $PUSH != 1 ]]; then echo; echo "not pushed (set PUSH=1 to push to ${REGISTRY})"; exit 0; fi

OUT="${HERE}/../../build"
ARCHIVE="${OUT}/${NAME}-${VERSION}-amd64.tar"
LAYOUT="${OUT}/${NAME}-${VERSION}-amd64"
rm -rf "$ARCHIVE" "$LAYOUT"
container image save --platform linux/amd64 -o "$ARCHIVE" "${IMAGE}:${VERSION}"
mkdir "$LAYOUT" && tar -xf "$ARCHIVE" -C "$LAYOUT"

echo "scanning (fails on fixable HIGH/CRITICAL)"
trivy image --quiet --input "$LAYOUT" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
syft -q "oci-dir:${LAYOUT}" -o "spdx-json=${OUT}/${NAME}-${VERSION}.spdx.json"

for TAG in "${TAGS[@]}"; do echo "pushing ${IMAGE}:${TAG}"; container image push "${IMAGE}:${TAG}"; done
echo; echo "SBOM: ${OUT}/${NAME}-${VERSION}.spdx.json"
