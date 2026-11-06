#!/usr/bin/env bash
#
# Local dev stack for WebAPI 3 + Atlas3 behind CHI Authentication, run with
# Apple's `container` on this Mac and fronted by rubeus's nginx at
# https://dev.lastchance.pub (see rubeus-ohdsi-studio.conf).
#
#   chi/devstack/up.sh      start (idempotent)
#   chi/devstack/down.sh    stop and remove the containers (data volume kept)
#
# CHI Authentication (:2069), the test IdP (:2053) and assets (:2063) are not
# started here; see README.md.
#
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=${IMAGE:-chi-tools.uc.edu/ohdsi-webapi:3.0.0-chi.1}
# The production Atlas3 image (chi/atlas/build.sh). Set ATLAS_IMAGE= (empty) to
# serve ATLAS_DIST, a local Atlas3 build, instead.
ATLAS_IMAGE=${ATLAS_IMAGE-chi-tools.uc.edu/atlas3:3.0.1-chi.1}
ATLAS_DIST=${ATLAS_DIST:-$HOME/Projects/Atlas3/dist}
VHOST=${VHOST:-dev.lastchance.pub}
ADMIN_LOGIN=${ADMIN_LOGIN:-iretonrt}
WEBAPI_PORT=28080
ATLAS_PORT=28527

mkdir -p secrets
[[ -s secrets/postgres-password ]] || openssl rand -hex 24 > secrets/postgres-password
[[ -s secrets/webapi-jwt-secret ]] || openssl rand -hex 32 > secrets/webapi-jwt-secret
[[ -s secrets/cacerts ]] || { echo "up.sh: secrets/cacerts missing (JDK trust store + internal CA); see README.md" >&2; exit 1; }
[[ -s secrets/jasypt-password ]] || openssl rand -hex 32 > secrets/jasypt-password
chmod 600 secrets/postgres-password secrets/webapi-jwt-secret secrets/jasypt-password

# Secrets reach WebAPI as files, one per property, read with Spring's
# configtree import -- not as environment variables, which leak into
# `inspect` output and child processes. Production does the same.
mkdir -p secrets/webapi-config && chmod 700 secrets/webapi-config
cp secrets/postgres-password secrets/webapi-config/datasource.password
cp secrets/postgres-password secrets/webapi-config/spring.flyway.password
cp secrets/webapi-jwt-secret secrets/webapi-config/security.jwt.secret
cp secrets/jasypt-password secrets/webapi-config/jasypt.encryptor.password
chmod 644 secrets/webapi-config/*   # read by the container's uid 101

running() { container ls | awk 'NR>1{print $1}' | grep -qx "$1"; }
exists() { container ls -a | awk 'NR>1{print $1}' | grep -qx "$1"; }
ip_of() { container ls | awk -v n="$1" '$1==n{print $6}' | cut -d/ -f1; }

container volume ls 2>/dev/null | grep -q '^webapi-pgdata\b' || container volume create webapi-pgdata >/dev/null

if ! running webapi-postgres; then
  exists webapi-postgres && container rm webapi-postgres >/dev/null
  container run -d --name webapi-postgres \
    -e POSTGRES_PASSWORD="$(cat secrets/postgres-password)" -e POSTGRES_DB=webapi \
    `# container volumes are ext4 with lost+found at the root, which initdb refuses` \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    -v webapi-pgdata:/var/lib/postgresql/data \
    docker.io/library/postgres:17 >/dev/null
fi
for _ in $(seq 1 30); do
  container exec webapi-postgres pg_isready -qU postgres && break
  sleep 2
done
container exec webapi-postgres psql -qU postgres -d webapi -c 'create schema if not exists webapi'
PG=$(ip_of webapi-postgres)

if ! running webapi; then
  exists webapi && container rm webapi >/dev/null
  # Non-secret settings are environment variables (Spring relaxed binding).
  # The upstream defaults that matter most are overridden: anonymous access is
  # off, the JWT secret is random rather than the hard-coded sample, and CDM
  # source passwords are encrypted with AES-256 rather than stored in clear.
  container run -d --name webapi -m 3G \
    -p "0.0.0.0:${WEBAPI_PORT}:8080" \
    -v "$PWD/secrets/cacerts:/etc/webapi-cacerts:ro" \
    -v "$PWD/secrets/webapi-config:/run/secrets/webapi:ro" \
    -e SPRING_CONFIG_IMPORT=configtree:/run/secrets/webapi/ \
    -e JAVA_OPTS="-Djavax.net.ssl.trustStore=/etc/webapi-cacerts -Djavax.net.ssl.trustStorePassword=changeit" \
    -e DATASOURCE_URL="jdbc:postgresql://${PG}:5432/webapi" \
    -e DATASOURCE_USERNAME=postgres -e SPRING_FLYWAY_USER=postgres \
    -e JASYPT_ENCRYPTOR_ENABLED=true \
    -e JASYPT_ENCRYPTOR_ALGORITHM=PBEWITHSHA256AND256BITAES-CBC-BC \
    -e SECURITY_ALLOWANONYMOUSACCESS=false \
    -e SECURITY_ADMINLOGIN="$ADMIN_LOGIN" \
    -e SECURITY_CORS_ENABLED=false \
    -e SECURITY_AUTH_ASSERTION_ENABLED=true \
    -e SECURITY_AUTH_ASSERTION_JWKSETURI="https://${VHOST}/auth/.well-known/jwks.json" \
    -e SECURITY_AUTH_ASSERTION_ISSUER="https://${VHOST}/auth/" \
    -e SECURITY_AUTH_ASSERTION_AUDIENCE="$VHOST" \
    -e SECURITY_AUTH_ASSERTION_PROVIDERNAME="CHI Sign-In" \
    -e SECURITY_AUTH_ASSERTION_LOGOUTURL="https://${VHOST}/auth/logout" \
    "$IMAGE" >/dev/null
fi

if ! running atlas3; then
  exists atlas3 && container rm atlas3 >/dev/null
  if [[ -n "$ATLAS_IMAGE" ]]; then
    container run -d --name atlas3 -p "0.0.0.0:${ATLAS_PORT}:80" "$ATLAS_IMAGE" >/dev/null
  else
    # container can't mount a file inside a directory mount, so serve a copy of
    # the build with our config in it. Rerun up.sh after rebuilding Atlas3.
    rm -rf secrets/atlas-www && mkdir -p secrets/atlas-www
    cp -R "${ATLAS_DIST}/" secrets/atlas-www/atlas
    cp ../atlas/config-local.json secrets/atlas-www/atlas/config-local.json
    cp ../atlas/plugins.json secrets/atlas-www/atlas/config/plugins.json
    container run -d --name atlas3 \
      -p "0.0.0.0:${ATLAS_PORT}:80" \
      -v "$PWD/secrets/atlas-www:/usr/share/nginx/html:ro" \
      docker.io/library/nginx:1.30-alpine >/dev/null
  fi
fi

echo "waiting for WebAPI..."
for _ in $(seq 1 90); do
  container logs webapi 2>&1 | grep -q 'Started WebApi' && break
  if container logs webapi 2>&1 | grep -q 'Application run failed'; then
    container logs webapi 2>&1 | grep -E 'Caused by|ERROR' | tail -5 >&2
    exit 1
  fi
  sleep 2
done
echo "WebAPI  http://localhost:${WEBAPI_PORT}/WebAPI/info  -> https://${VHOST}/WebAPI/"
echo "Atlas3  http://localhost:${ATLAS_PORT}/atlas/         -> https://${VHOST}/atlas/"
