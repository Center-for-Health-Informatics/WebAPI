#!/usr/bin/env bash
#
# Create ./secrets for compose.yaml. Run once, as root, in /srv/ohdsi-webapi:
#
#   sudo ./init-secrets.sh
#
# Existing files are never overwritten. In particular, keep jasypt-password:
# it decrypts the CDM source passwords stored in Postgres.
set -euo pipefail
cd "$(dirname "$0")"

[[ $EUID -eq 0 ]] || { echo "init-secrets.sh: run as root" >&2; exit 1; }

umask 077
mkdir -p secrets
chown root:root secrets
chmod 700 secrets   # only root on the host can reach the files below

gen() { [[ -s secrets/$1 ]] || { openssl rand -hex "$2" > "secrets/$1"; echo "created secrets/$1"; }; }
gen postgres-password 24
gen jwt-secret 32
gen jasypt-password 32

# Compose mounts each file directly into the container, where the
# non-root postgres (999) and webapi (101) users must read it. The 0700
# directory above is what keeps other host users out.
chmod 444 secrets/*
echo "secrets ready"
