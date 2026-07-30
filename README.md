# WebAPI-node

A Node.js drop-in replacement for [OHDSI WebAPI](https://github.com/OHDSI/WebAPI) — the backend REST API that powers [Atlas](https://github.com/OHDSI/Atlas).

It is Atlas-compatible: the JSON response shapes match the Java WebAPI exactly, so Atlas works without modification. CDM access is SQL Server only. Application state is stored in SQLite. Authentication is handled upstream by an nginx reverse proxy.

## Differences from Java WebAPI

| Feature | Java WebAPI | WebAPI-node |
|---|---|---|
| Runtime | Java 8 / Spring Boot | Node.js LTS (+ a JRE, for CIRCE — see below) |
| App database | PostgreSQL / SQL Server | SQLite |
| CDM databases | Any OHDSI dialect | SQL Server only |
| Auth | Shiro (JDBC, LDAP, OAuth, SAML) | External (nginx header) |
| Source config | Admin UI + database | Environment variable |
| Cohort generation | CIRCE → SQL | CIRCE → SQL, via a bundled `circe.jar` CLI (see [CIRCE](#circe) below) |
| IR / Pathway analysis execution | Spring Batch | Implemented directly against already-generated cohort tables (no Spring Batch/Arachne) |
| Estimation / Prediction / Cohort Characterization execution | Spring Batch + Arachne | **Not implemented** (returns 501) — needs the Arachne execution engine |

Vocabulary search, concept sets, CDM Results (Achilles), Cohort Results (Heracles), cohort generation (CIRCE), IR and Pathway analysis execution, and all CRUD for cohort definitions, IR analyses, cohort characterizations, pathway analyses, estimation, and prediction are fully implemented. Estimation, Prediction, and Cohort Characterization *execution* (which requires the Arachne execution engine, a separate distributed platform) is not.

## Quick Start

### Docker

```bash
cp .env.example .env
# Edit .env — set WEBAPI_SOURCES, HTTP_PORT, EXPRESS_PORT at minimum
docker compose up
```

`compose.yaml` reads all configuration from `.env`. Docker Compose will error on startup if `.env` is missing or if `HTTP_PORT` / `EXPRESS_PORT` are not set, since they are required for the port mapping.

### Local development

```bash
npm install
DB_PATH=/tmp/webapi.db WEBAPI_SOURCES='[...]' npm run dev
```

Cohort generation shells out to a bundled CIRCE CLI jar (`lib/circe.jar`), so a JRE must be on `PATH` (`java -version`). The jar itself is not checked in — build it first with `scripts/build-circe.sh` (see [CIRCE](#circe) below). Without it, `POST /cohortdefinition/sql` and `GET /cohortdefinition/:id/generate/:sourceKey` will fail.

## Configuration

All configuration is through environment variables. No config files.

| Variable | Default | Description |
|---|---|---|
| `EXPRESS_PORT` | `8080` | HTTP listen port |
| `EXPRESS_HOST` | `0.0.0.0` | HTTP listen address |
| `DB_PATH` | `/data/webapi.db` | Path to the SQLite database file. The directory must exist. |
| `WEBAPI_SOURCES` | `[]` | JSON array of CDM source objects (see below) |
| `WEBAPI_AUTH_HEADER` | `x-forwarded-user` | Request header containing the authenticated username, set by the upstream proxy |
| `WEBAPI_VERSION` | `2.15.1` | Version string reported by `GET /info` |

### CDM Sources

`WEBAPI_SOURCES` is a JSON array. Each entry defines one CDM database connection:

```json
[
  {
    "sourceKey":        "my_cdm",
    "sourceName":       "My CDM",
    "connectionString": "Server=db.example.com,1433;Database=cdm;Encrypt=true;TrustServerCertificate=true;",
    "username":         "sa",
    "password":         "secret",
    "cdmSchema":        "dbo",
    "vocabSchema":      "dbo",
    "resultsSchema":    "results",
    "tempSchema":       "temp"
  }
]
```

Multiple sources are supported. Atlas will show all of them in its source picker.

`vocabSchema` and `cdmSchema` can point to the same schema if the vocabulary tables are co-located with the CDM tables. `resultsSchema` is where Achilles and Heracles pre-computed results are stored.

## Authentication

WebAPI-node does **not** implement authentication itself. It reads a single HTTP request header (configured via `WEBAPI_AUTH_HEADER`) and treats its value as the authenticated username. All requests are granted full access.

In production, place an nginx reverse proxy in front that authenticates users and injects the header:

```nginx
location /WebAPI/ {
    proxy_pass http://webapi:8080/;
    proxy_set_header x-forwarded-user $remote_user;
}
```

Without a proxy (e.g. in development), every request runs as `anonymous`.

## CIRCE

Cohort definitions are compiled to SQL by [CIRCE](https://github.com/OHDSI/circe-be), the same Java library the original WebAPI uses. Rather than embedding it as a library, this project shells out to a small CLI wrapper jar (`lib/circe.jar`) — see [src/circe.js](src/circe.js): it spawns `java -jar lib/circe.jar`, writes the cohort expression JSON to stdin, and reads generated SQL back from stdout.

The jar is built from the sibling `circe` repo (checked out alongside this one, i.e. `../circe` relative to `webapi/`) via [scripts/build-circe.sh](scripts/build-circe.sh):

```bash
scripts/build-circe.sh   # requires mvn, or falls back to docker/podman running a maven image
```

This produces `lib/circe.jar`, which is *not* checked into version control and must be rebuilt whenever the `circe` submodule/checkout changes. The Docker image copies the pre-built jar in, so run `scripts/build-circe.sh` before building the image — otherwise the build fails on the missing file.

## Docker

The image installs `default-jre-headless` (needed to run `lib/circe.jar` for cohort generation) and bundles the pre-built jar. It mounts a single volume at `/data` for the SQLite database. The database schema is created automatically on first startup via numbered migration files.

### Building

`build.sh` produces a multi-arch (`linux/amd64` + `linux/arm64`) image with podman, so a build on an Apple Silicon machine runs on the AMD64 deployment hosts. It tags three names — the `package.json` version, that version plus the short git SHA, and `latest` — and pushes only when asked:

```bash
./build.sh            # build only; nothing leaves this machine
PUSH=1 ./build.sh     # build and push to chi-tools.uc.edu
```

Pushing needs a one-time `podman login chi-tools.uc.edu`. Pushes from a dirty working tree are refused (override with `FORCE=1`). Overrides: `REGISTRY`, `PLATFORMS`.

Because `better-sqlite3` is a native module, `node_modules` must be installed per target architecture, so the `linux/amd64` leg runs under QEMU emulation on Apple Silicon and is noticeably slower than the arm64 leg. `PLATFORMS=linux/arm64 ./build.sh` skips it for a quick local build. (Atlas can avoid emulation entirely; this image can't.)

### Running

```bash
podman run -p 8080:80 \
  -v $(pwd)/data:/data \
  -e WEBAPI_SOURCES='[{"sourceKey":"cdm",...}]' \
  chi-tools.uc.edu/webapi:latest
```

For deployment, [`deploy/compose.yaml`](deploy/compose.yaml) pulls from the registry instead of building locally — copy it, plus `.env`, to `/srv/webapi` on the target host. The repo-root `compose.yaml` still uses `build: .` for local development.

## API Coverage

### Fully implemented

| Prefix | Description |
|---|---|
| `GET /info` | Version info |
| `GET /source/sources` | CDM source list |
| `GET /source/:key` | Single source |
| `GET /user/me` | Current user |
| `/vocabulary/:sourceKey/…` | Concept search, lookup, descendants, ancestors, domains, vocabularies |
| `/conceptset/…` | Concept set CRUD + items + expression resolution |
| `/cohortdefinition/…` | Cohort definition CRUD + CIRCE-backed SQL generation (`POST /sql`) + execution (`GET /:id/generate/:sourceKey`) + inclusion-rule report |
| `/cdmresults/:sourceKey/…` | Achilles reports: dashboard, person, datadensity, death, observation period, domain treemaps + drilldowns |
| `/cohortresults/:sourceKey/…` | Heracles cohort results: dashboard, person, domain treemaps + drilldowns, data completeness |
| `/ir/…` | Incidence rate analysis CRUD + versioning + real execution (`GET /:id/execute/:sourceKey`) and report, computed directly against generated cohorts |
| `/cohort-characterization/…` | Cohort characterization CRUD + versioning |
| `/pathway-analysis/…` | Pathway analysis CRUD + versioning + real execution (`POST /:id/generation/:sourceKey`), computed directly against generated cohorts |
| `/estimation/…` | Estimation CRUD + versioning |
| `/prediction/…` | Prediction CRUD + versioning |
| `/tag/…` | Tag CRUD + multi-assign/unassign |
| `/:sourceKey/person/:personId` | Patient profile (CDM query) |
| `/notifications/…` | Job activity feed Atlas polls |
| `/job/…` | Job execution status |

### Not implemented (returns 501)

| Endpoint | Reason |
|---|---|
| `POST /:analysisType/:id/generation/:sourceKey` for `estimation`, `prediction`, `cohort-characterization` | Requires the Arachne execution engine (a separate distributed platform — Central/Datanode/Execution Engine + R packages) |
| `POST /ir/sql` | IR's per-stratum breakdown is a full CIRCE `CriteriaGroup` expression; not yet wired to CIRCE (execution itself works — see above) |

`ir` and `pathway-analysis` execution deliberately skip both CIRCE and Arachne: target/outcome/event cohorts in those analyses are references to *already-generated* cohorts, so their math is plain SQL against `${resultsSchema}.cohort` — no external engine needed. Estimation, Prediction, and Cohort Characterization execution genuinely need Arachne and are out of scope for a single local instance.

## Project Structure

```
src/
├── server.js          — entry point (bind port, start listening)
├── app.js             — Express app (routes wired here)
├── config.js          — env var parsing
├── db.js              — SQLite setup + migrations
├── sources.js         — CDM source pool management
├── sqlrender.js       — @param substitution into SQL templates
├── jobResource.js     — Spring Batch job shape Atlas expects
├── conceptSetExpression.js — JS port of CIRCE concept set SQL builder
├── circe.js           — spawns lib/circe.jar to compile cohort expressions to SQL
├── ir-generation.js   — Incidence Rate execution: TAR-clipping + case-counting SQL
├── pathway-generation.js — Cohort Pathways execution: per-person event-ordering SQL
├── middleware/
│   ├── user.js        — populate req.user from auth header
│   └── errors.js      — JSON error handler
├── routes/            — one file per URL prefix
└── sql/               — SQL templates (copied from Java WebAPI resources)
    ├── cdmresults/    — Achilles report SQL (~129 files)
    ├── cohortresults/ — Heracles result SQL (~114 files)
    ├── vocabulary/    — concept search SQL
    ├── cohortdefinition/
    └── person/        — patient profile SQL

migrations/            — numbered SQLite schema files (run on startup)
scripts/
└── build-circe.sh      — builds lib/circe.jar from the sibling ../circe repo
lib/
└── circe.jar           — CIRCE CLI jar (build artifact, not checked in — see CIRCE section above)
```

## Dependencies

Three runtime npm packages:

| Package | Purpose |
|---|---|
| `express` | HTTP server and routing |
| `better-sqlite3` | Synchronous SQLite for application state |
| `mssql` | SQL Server driver with connection pooling |

Dev: `nodemon` (hot reload).

Plus one system dependency: a JRE, to run the bundled `lib/circe.jar` for cohort generation (installed automatically in the Docker image; must be present on `PATH` for local development).

## SQLite Schema

The application database stores all Atlas-managed definitions. The schema is applied automatically from `migrations/` on first startup.

Key tables: `cohort_definition`, `cohort_definition_details`, `concept_set`, `concept_set_item`, `ir_analysis`, `ir_generation_info`, `ir_analysis_result`, `cc_analysis`, `pathway_analysis`, `pathway_generation`, `estimation`, `prediction`, `tag`, `entity_tag`, `version`, `job`, `notifications_viewed`.

The database file persists across container restarts via the `/data` volume mount. To reset all application state, delete the `.db` file — it will be recreated on next startup.

## License

Apache 2.0
