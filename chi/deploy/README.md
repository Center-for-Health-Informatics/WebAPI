# Production: Atlas3 + WebAPI 3 on chi-tools.uc.edu

A fresh start on WebAPI 3. Nothing is migrated from the Node WebAPI demo, which
this replaces at the same paths (`/atlas/`, `/WebAPI/`).

```
browser ── https ──► chi-hermes nginx (UC; CHI auth, auth_request)
                       ├─ /atlas/  ── http ──► chi-cetus: Atlas3 container (static)
                       └─ /WebAPI/ ── https ─► asclepius.uchealth.com nginx (aquarius, UC Health)
                                                 └─ http ─► chi-escher: WebAPI 3 + Postgres (Docker)
                                                              └─ TLS ─► chi-resdbstg.healthall.com
                                                                         OMOP_CDM_2026 (SQL Server)
```

| Directory | Goes to | What |
|---|---|---|
| [webapi/](webapi/) | chi-escher `/srv/ohdsi-webapi` | WebAPI + Postgres compose, settings, secrets script, SQL |
| [asclepius/](asclepius/) | aquarius nginx | `/WebAPI/` → chi-escher |
| [atlas/](atlas/) | chi-cetus `/srv/atlas3` | Atlas3 compose |
| [hermes/](hermes/) | chi-hermes nginx | `/atlas/` → chi-cetus, `/WebAPI/` → asclepius |

Images are built and pushed from the build machine (`../../build.sh`,
`../atlas/build.sh`); servers only pull, and need only `docker login
chi-tools.uc.edu`. Images are pinned by tag (ours) or digest (third-party).

**Placeholders** to fill in: `BIND_ADDRESS` (each host's `.env`),
`ATLAS_PORT`, `CHI_CETUS_ATLAS_PORT`, `CHI_HERMES_ADDRESS`, `CHI_ESCHER_HOST`.

## Security decisions

- **Identity** is CHI auth's signed `sso-assertion` (ES256, `iss`
  `https://chi-tools.uc.edu/auth/`, `aud` `chi-tools.uc.edu`), verified by
  WebAPI against the JWKS. Every request with a WebAPI session token must also
  carry a matching assertion, so a leaked token is useless without a live CHI
  session. Anonymous access is off; `iretonrt` is made admin on sign-in.
- **Secrets are files** (Spring `configtree:`), never environment variables:
  Postgres password, WebAPI JWT secret, jasypt key. `secrets/` is 0700 root.
- **CDM source passwords are encrypted** in Postgres (jasypt, AES-256).
  Upstream stores them in clear by default. Back up `secrets/jasypt-password`
  separately: without it the source password must be re-entered.
- **Least privilege on SQL Server**: WebAPI reads `dbo` (CDM + vocabulary) and
  writes only `webapi_results` and `webapi_temp`.
- **Postgres** has no published port and no network route out.
- **Ports** on chi-escher and chi-cetus accept only the next hop
  (aquarius, chi-hermes). Note that Docker-published ports bypass `ufw`;
  filter in the `DOCKER-USER` chain (below) or at the network firewall.
  `DOCKER-USER` sees packets after Docker's port translation, so the rules
  below match the original destination port with conntrack.
- The aquarius → chi-escher hop is plain HTTP inside UC Health and carries
  the assertion, tokens and query results.

## First deployment

### 1. Images (build machine)

`chi-tools.uc.edu/ohdsi-webapi:3.0.0-chi.1` is already pushed. Build and push
Atlas3: `PUSH=1 chi/atlas/build.sh` (bump `chi/atlas/CHI_VERSION` and the tag
in `atlas/compose.yaml` for later releases).

### 2. SQL Server (DBA, or someone with db_owner on OMOP_CDM_2026)

```sh
cd webapi/sql
sqlcmd -S chi-resdbstg.healthall.com -d OMOP_CDM_2026 -b -v WEBAPI_USER=<user> -i 10-schemas.sql
# then as the WebAPI user itself, which also proves its permissions:
sqlcmd -S chi-resdbstg.healthall.com -d OMOP_CDM_2026 -U <user> -b -i 20-results-ddl.sql
```

`10-schemas.sql` creates `webapi_results` and `webapi_temp` and grants the
WebAPI user read on `dbo`, write on the two new schemas. `20-results-ddl.sql`
creates WebAPI's results tables and fills `concept_hierarchy` from the
vocabulary (a few minutes). Both are safe to re-run. The Node demo's
`results`/`temp` schemas are untouched.

### 3. chi-escher (WebAPI + Postgres)

```sh
sudo mkdir -p /srv/ohdsi-webapi && cd /srv/ohdsi-webapi
# copy compose.yaml, webapi.env, init-secrets.sh, initdb/ from webapi/
echo 'BIND_ADDRESS=<chi-escher address aquarius connects to>' | sudo tee .env
sudo ./init-secrets.sh
# only aquarius may reach :8080 (Docker bypasses ufw, so use DOCKER-USER):
sudo iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL ! -s <aquarius address> -j DROP
#   (persist it with iptables-persistent or your host firewall tooling)
sudo docker compose pull && sudo docker compose up -d
sudo docker compose logs -f webapi    # wait for "Started WebApi"
```

WebAPI needs outbound access to `https://chi-tools.uc.edu/auth/.well-known/jwks.json`
(public-CA certificate, no extra trust store) and to chi-resdbstg:1433. Check
from the host: `curl -sS https://chi-tools.uc.edu/auth/.well-known/jwks.json`.

### 4. aquarius (asclepius.uchealth.com nginx)

Include [asclepius/ohdsi-webapi.conf](asclepius/ohdsi-webapi.conf) in the
asclepius https server block, fill in the placeholders, `nginx -t`, reload.

### 5. chi-cetus (Atlas3)

```sh
sudo mkdir -p /srv/atlas3 && cd /srv/atlas3    # copy atlas/compose.yaml
printf 'BIND_ADDRESS=<address chi-hermes connects to>\nATLAS_PORT=<port>\n' | sudo tee .env
sudo iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport <port> --ctdir ORIGINAL ! -s <chi-hermes address> -j DROP
sudo docker compose pull && sudo docker compose up -d
```

### 6. chi-hermes (cutover)

Replace the Node WebAPI / old Atlas locations with
[hermes/ohdsi.conf](hermes/ohdsi.conf), fill in the placeholders, `nginx -t`,
reload. Make sure CHI auth lists `/atlas/` and `/WebAPI/` as a protected
resource (with `ALLOW_UNLISTED`, unlisted paths are served without sign-in).
Rollback is restoring the previous snippet.

### 7. Data source (in Atlas, as iretonrt)

Configuration → Data Sources → new source:

| Field | Value |
|---|---|
| Key | `OMOP_CDM_2026` |
| Name | `OMOP CDM 2026` |
| Dialect | SQL Server |
| Connection string | `jdbc:sqlserver://chi-resdbstg.healthall.com:1433;databaseName=OMOP_CDM_2026;encrypt=true;trustServerCertificate=true` |
| Username / password | the WebAPI user |
| Daimons | CDM `dbo`, Vocabulary `dbo`, Results `webapi_results`, Temp `webapi_temp` |

(`trustServerCertificate=true` matches the current Node configuration; drop
it if the SQL Server certificate chains to a CA the JVM trusts.)

### 8. Achilles (data source reports)

Run [Center-for-Health-Informatics/Achilles](https://github.com/Center-for-Health-Informatics/Achilles)
with results schema `webapi_results`, as a user that can write there. It
encrypts the connection by default; add `--trust-server-certificate` to match
the setting above.

### 9. Verify

- Sign in at `https://chi-tools.uc.edu/atlas/` as an admin and as a regular
  user; the regular user must get 403 on role administration.
- `curl -i https://chi-tools.uc.edu/WebAPI/info` without a CHI session is
  redirected to sign-in; from aquarius, `curl -i http://<chi-escher>:8080/WebAPI/user/me` is 401.
- From anywhere other than aquarius, chi-escher:8080 doesn't answer; Postgres
  isn't reachable at all.
- Data Sources dashboard shows the person count; generate a simple cohort and
  compare its count with a direct SQL count.

### 10. Afterwards

Stop the Node WebAPI stack, and once nothing needs them, drop the Node demo's
tables from `results`/`temp`.

## Upgrades

Edit the image tag in the compose file, `docker compose pull && docker
compose up -d`. WebAPI's Flyway migrates Postgres on start; back up the
volume first (`docker compose exec postgres pg_dump -U webapi webapi`). If a
new WebAPI version changes the results DDL, regenerate it with
`webapi/sql/make-results-ddl.sh` against the dev stack.
