#!/usr/bin/env bash
#
# Build the CHI WebAPI image for linux/amd64 + linux/arm64 with Apple's
# `container` tool and, with PUSH=1, push it to the CHI registry. The deploy
# host only ever pulls.
#
#   ./build.sh              build only, nothing leaves this machine
#   PUSH=1 ./build.sh       test, build, scan, and push to $REGISTRY
#
# One-time setup:
#   container system start
#   container registry login chi-tools.uc.edu
# Pushing also needs trivy (vulnerability gate), syft (SBOM) and skopeo
# (checks the tag isn't already taken; it uses its own login:
# `skopeo login chi-tools.uc.edu`).
#
# The version comes from the CHI_VERSION file (e.g. 3.0.0-chi.1). Bump it for
# every image you push; tags are never reused.
#
# Environment overrides:
#   REGISTRY    registry host           (default chi-tools.uc.edu)
#   PLATFORMS   comma-separated targets (default linux/amd64,linux/arm64)
#   PUSH        set to 1 to push
#   FORCE       set to 1 to allow pushing from a dirty working tree
#   SKIP_TESTS  set to 1 to skip `mvnw test` (never honoured with PUSH=1)
#
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY=${REGISTRY:-chi-tools.uc.edu}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}
NAME=ohdsi-webapi

VERSION=$(tr -d '[:space:]' < CHI_VERSION)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REVISION=$(git rev-parse --short HEAD)
git diff --quiet HEAD -- . || REVISION="${REVISION}-dirty"

IMAGE="${REGISTRY}/${NAME}"
PUSH=${PUSH:-0}
TAGS=("${VERSION}" "${VERSION}-g${REVISION}" latest)

die() { echo "build.sh: $*" >&2; exit 1; }

command -v container >/dev/null 2>&1 || die "Apple's container tool is required"
container system status >/dev/null 2>&1 || die "container system is not running (container system start)"

if [[ $PUSH == 1 ]]; then
  [[ "$REVISION" != *-dirty || ${FORCE:-0} == 1 ]] ||
    die "refusing to push a build from a dirty working tree. Commit first, or set FORCE=1."
  for t in trivy syft skopeo; do
    command -v $t >/dev/null 2>&1 || die "$t is required to push"
  done
  if out=$(skopeo inspect --raw "docker://${IMAGE}:${VERSION}" 2>&1); then
    die "${IMAGE}:${VERSION} already exists in the registry. Bump CHI_VERSION."
  elif ! grep -qiE 'manifest unknown|not found' <<<"$out"; then
    die "could not check ${IMAGE}:${VERSION} in the registry: ${out}"
  fi
fi

# Unit tests run on the host, which needs JDK 21: the build's Groovy step
# can't read newer class files. The image build itself skips tests.
if [[ $PUSH == 1 || ${SKIP_TESTS:-0} != 1 ]]; then
  for jdk in "${JAVA_HOME:-}" /opt/homebrew/opt/openjdk@21 \
             "$(/usr/libexec/java_home -v 21 2>/dev/null || true)"; do
    if [[ -n "$jdk" && -x "$jdk/bin/java" ]] && "$jdk/bin/java" -version 2>&1 | grep -q '"21\.'; then
      export JAVA_HOME=$jdk
      break
    fi
  done
  [[ -n "${JAVA_HOME:-}" ]] && "$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"21\.' ||
    die "JDK 21 is required for mvnw test (set JAVA_HOME, or SKIP_TESTS=1 for a local-only build)"
  ./mvnw -B -q test
fi

# One --platform per target builds every leg into a single multi-arch image.
# Dockerfile.chi compiles once on the build platform, so no leg runs Maven
# under emulation.
PLATFORM_ARGS=()
IFS=, read -ra PLATFORM_LIST <<<"$PLATFORMS"
for p in "${PLATFORM_LIST[@]}"; do PLATFORM_ARGS+=(--platform "$p"); done

container build \
  -f Dockerfile.chi \
  "${PLATFORM_ARGS[@]}" \
  -t "${IMAGE}:${VERSION}" \
  --build-arg VERSION="$VERSION" \
  --build-arg REVISION="$REVISION" \
  --build-arg CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg GIT_BRANCH="$BRANCH" \
  --build-arg GIT_COMMIT_ID_ABBREV="${REVISION%-dirty}" \
  .

for TAG in "${TAGS[@]:1}"; do
  container image tag "${IMAGE}:${VERSION}" "${IMAGE}:${TAG}"
done

echo
for TAG in "${TAGS[@]}"; do echo "built ${IMAGE}:${TAG}"; done

if [[ $PUSH != 1 ]]; then
  echo
  echo "not pushed (set PUSH=1 to push to ${REGISTRY})"
  exit 0
fi

# Scan and SBOM the linux/amd64 leg, the one the deploy host runs. Both legs
# carry the same jar and the same Temurin release.
# container saves an OCI layout as a tar; trivy and syft want it unpacked.
mkdir -p build
ARCHIVE="build/${NAME}-${VERSION}-amd64.tar"
LAYOUT="build/${NAME}-${VERSION}-amd64"
rm -rf "$ARCHIVE" "$LAYOUT"
container image save --platform linux/amd64 -o "$ARCHIVE" "${IMAGE}:${VERSION}"
mkdir "$LAYOUT"
tar -xf "$ARCHIVE" -C "$LAYOUT"

echo "scanning (fails on fixable HIGH/CRITICAL; accepted findings live in .trivyignore)"
trivy image --quiet --input "$LAYOUT" \
  --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1

echo "writing SBOM"
syft -q "oci-dir:${LAYOUT}" -o "spdx-json=build/${NAME}-${VERSION}.spdx.json"

# Without --platform, push sends the whole multi-arch index.
for TAG in "${TAGS[@]}"; do
  echo "pushing ${IMAGE}:${TAG}"
  container image push "${IMAGE}:${TAG}"
done

echo
echo "SBOM: build/${NAME}-${VERSION}.spdx.json"
