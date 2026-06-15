#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCE_DIR="$(cd "$SCRIPT_DIR/../../circe" && pwd)"
DEST="$SCRIPT_DIR/../lib/circe.jar"

echo "Building circe-cli from $CIRCE_DIR ..."
cd "$CIRCE_DIR"

if command -v mvn &>/dev/null; then
  mvn clean package -Dmaven.test.skip=true -q
elif command -v docker &>/dev/null; then
  docker run --rm -v "$CIRCE_DIR":/circe -w /circe maven:3-eclipse-temurin-21 \
    mvn clean package -Dmaven.test.skip=true -q
elif command -v podman &>/dev/null; then
  podman run --rm -v "$CIRCE_DIR":/circe -w /circe maven:3-eclipse-temurin-21 \
    mvn clean package -Dmaven.test.skip=true -q
else
  echo "Error: mvn, docker, or podman is required to build circe.jar." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp target/circe-cli.jar "$DEST"
echo "Done: $(du -h "$DEST" | cut -f1) written to lib/circe.jar"
