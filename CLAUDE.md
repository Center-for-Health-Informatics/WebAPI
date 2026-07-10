# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OHDSI WebAPI is a Node.js drop-in replacement for the original Java OHDSI WebAPI. It exposes the same REST API consumed by Atlas, runs at `http://localhost:8080`, and connects to one or more CDM (SQL Server) databases plus a local SQLite application database.

Cohort generation is backed by a real CIRCE integration (a bundled CLI jar, not a stub) — see "CIRCE (cohort generation)" below. IR and Pathway analysis execution are also real, computed directly in SQL against already-generated cohorts. Estimation, Prediction, and Cohort Characterization *execution* remain unimplemented (501) — they need the Arachne execution engine, a separate distributed platform out of scope for a single local instance.

## Build & Run

### Local development

```bash
npm install
npm run dev   # nodemon — restarts on file changes
```

### Production / Docker

```bash
docker compose up
```

Configure CDM sources via the `WEBAPI_SOURCES` environment variable (JSON array — see `compose.yaml` for the schema). The SQLite database is persisted at `DB_PATH` (default `/data/webapi.db`).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `EXPRESS_PORT` | `8080` | HTTP listen port |
| `EXPRESS_HOST` | `0.0.0.0` | HTTP listen host |
| `DB_PATH` | `/data/webapi.db` | SQLite application database path |
| `WEBAPI_AUTH_HEADER` | `x-forwarded-user` | Request header used to identify the current user |
| `WEBAPI_VERSION` | `2.15.1` | Version string returned by `/info` |
| `WEBAPI_SOURCES` | `[]` | JSON array of CDM source objects |

The service trusts whatever value the auth header contains — it is designed to sit behind an authenticating proxy. Set `WEBAPI_AUTH_HEADER` to match whatever your proxy injects.

### CIRCE (cohort generation)

Cohort definitions are compiled to SQL by shelling out to `lib/circe.jar`, a small CLI wrapper around the real [CIRCE](https://github.com/OHDSI/circe-be) Java library ([src/circe.js](src/circe.js) spawns `java -jar lib/circe.jar`, passing the cohort expression JSON over stdin and reading generated SQL from stdout). This requires a JRE on `PATH`.

The jar is built from the sibling `circe` checkout (`../circe` relative to this repo) via `scripts/build-circe.sh` (uses `mvn` if available, otherwise `docker`/`podman` running a Maven image). `lib/circe.jar` is a build artifact, not checked into version control — rebuild it after any change to the `../circe` checkout. The Docker image builds and bundles it automatically, and installs `default-jre-headless` to run it at container runtime.

## Testing

```bash
npm test   # node --test (Node built-in runner)
```

No test files exist yet. New tests belong alongside the code they cover or in a `test/` directory, using the Node built-in `node:test` module.

## Architecture

### Stack

- **Node.js** (ESM, `"type": "module"`) with **Express 5**
- **SQLite** (`better-sqlite3`) — synchronous, embedded application database
- **mssql** — one connection pool per CDM source (SQL Server)
- No build step; `node src/server.js` runs directly

### Entry points

| File | Role |
|---|---|
| [src/server.js](src/server.js) | Process entry — runs migrations, connects sources, starts HTTP |
| [src/config.js](src/config.js) | Reads env vars into a frozen config object |
| [src/db.js](src/db.js) | Opens SQLite, runs pending migrations from `migrations/` |
| [src/sources.js](src/sources.js) | Opens mssql pools for each `WEBAPI_SOURCES` entry |
| [src/app.js](src/app.js) | Express app — CORS, user middleware, route mounting |
| [src/circe.js](src/circe.js) | Spawns `lib/circe.jar` to compile cohort expressions to SQL — used by `routes/cohortdefinition.js` |
| [src/ir-generation.js](src/ir-generation.js) | Incidence Rate execution: TAR-clipping + case-counting SQL against generated cohorts — used by `routes/ir.js` |
| [src/pathway-generation.js](src/pathway-generation.js) | Cohort Pathways execution: per-person event-ordering against generated cohorts — used by `routes/pathway.js` |

### Database tiers

**Application database (SQLite)** — stores cohort definitions, concept sets, analyses, tags, notifications, jobs. Migrations live in `migrations/` as numbered SQL files (`001_initial.sql`, `002_…`, …). `src/db.js` applies them in order at startup, tracking applied files in a `_migrations` table.

**CDM source databases (SQL Server)** — patient-level OMOP CDM data. Each source is configured via `WEBAPI_SOURCES` with `cdmSchema`, `vocabSchema`, `resultsSchema`, and `tempSchema` fields. Connection pools are created at startup in `src/sources.js`.

### SQL templating

[src/sqlrender.js](src/sqlrender.js) provides two helpers:

- `loadSql(relativePath)` — reads a file from `src/sql/`
- `renderSql(sql, source, extraParams)` — substitutes `@param` tokens with schema qualifiers and any extra values

Schema names are interpolated directly (they are SQL identifiers, not data). User-supplied values must be bound via mssql parameters, not `renderSql`.

SQL templates live in `src/sql/` organised by domain (`vocabulary/`, `cohortresults/`, `cdmresults/`, `person/`).

### Routes

Each domain has a file in `src/routes/`. Routes are plain Express routers mounted in `src/app.js`:

| Mount path | File |
|---|---|
| `/info` | [src/routes/info.js](src/routes/info.js) |
| `/source` | [src/routes/source.js](src/routes/source.js) |
| `/vocabulary` | [src/routes/vocabulary.js](src/routes/vocabulary.js) |
| `/conceptset` | [src/routes/conceptset.js](src/routes/conceptset.js) |
| `/cohortdefinition` | [src/routes/cohortdefinition.js](src/routes/cohortdefinition.js) |
| `/cdmresults` | [src/routes/cdmresults.js](src/routes/cdmresults.js) |
| `/cohortresults` | [src/routes/cohortresults.js](src/routes/cohortresults.js) |
| `/ir` | [src/routes/ir.js](src/routes/ir.js) |
| `/cohort-characterization` | [src/routes/cohortcharacterization.js](src/routes/cohortcharacterization.js) |
| `/feature-analysis` | [src/routes/featureanalysis.js](src/routes/featureanalysis.js) |
| `/pathway-analysis` | [src/routes/pathway.js](src/routes/pathway.js) |
| `/estimation` | [src/routes/estimation.js](src/routes/estimation.js) |
| `/prediction` | [src/routes/prediction.js](src/routes/prediction.js) |
| `/tag` | [src/routes/tags.js](src/routes/tags.js) |
| `/job` | [src/routes/job.js](src/routes/job.js) |
| `/notifications` | [src/routes/notifications.js](src/routes/notifications.js) |
| `/permission` | [src/routes/permission.js](src/routes/permission.js) |
| `/cache` | [src/routes/cache.js](src/routes/cache.js) |
| `/tool` | [src/routes/tool.js](src/routes/tool.js) |
| `/cohortsample` | [src/routes/cohortsample.js](src/routes/cohortsample.js) |
| `/reusable` | [src/routes/reusable.js](src/routes/reusable.js) |
| `/featureextraction` | [src/routes/featureextraction.js](src/routes/featureextraction.js) |
| `/evidence` | [src/routes/evidence.js](src/routes/evidence.js) |
| `/:sourceKey/person` | [src/routes/person.js](src/routes/person.js) |
| `/` | [src/routes/user.js](src/routes/user.js) |

### Middleware

- **[src/middleware/user.js](src/middleware/user.js)** — reads `WEBAPI_AUTH_HEADER` from the request and attaches `req.user = { login, name }`. Falls back to `"anonymous"`.
- **[src/middleware/errors.js](src/middleware/errors.js)** — Express error handler; maps `err.status` to HTTP status codes.
