# Atlas Compatibility Audit

This document records what we know about response-shape mismatches between this Node.js WebAPI and the original Java OHDSI WebAPI, how we discovered them, and how to run better comparisons in the future.

---

## Background

Atlas makes direct HTTP calls to WebAPI and reads specific fields from the responses. Mismatches between what we return and what Atlas expects produce silent failures (JS exceptions caught by `.catch`, empty UI panels, `undefined` leaking into URLs) rather than obvious errors. The systematic review we did used a Java DTO agent to compare Java class definitions against our Node.js DTOs.

---

## Bugs Found and Fixed

### Critical — broke entire cohort load flow

**`GET /cohortdefinition/:id` returned `expression` as a parsed object.**  
The Java WebAPI serializes `expression` as a raw JSON string. Atlas immediately calls `JSON.parse(cohortDef.expression)` on the response. When we returned a JS object, `JSON.parse(object)` coerced to `"[object Object]"` → `SyntaxError` → caught silently → `new CohortDefinition(undefined)` → `id() = undefined` → every subsequent URL became `/cohortdefinition/undefined/…`.  
*Fix:* Return `expression` as the raw SQLite string, not `JSON.parse()`d.

**`POST /cohortdefinition/sql` returned plain text.**  
Atlas's `sql.js` component does `this.templateSql(sql && sql.templateSql)`. We returned a string; `string.templateSql` is `undefined`; the SQL textarea was always empty even though the SQL was generated correctly (visible in the Network tab).  
*Fix:* Return `{ templateSql: sql }`.

### Broken display / JS errors

**`POST /cohortdefinition/checkV2` returned `[]`.**  
`warnings.js` does `result.warnings.filter(...)`. An array has no `.warnings` property → `TypeError` on every cohort definition page load.  
*Fix:* Return `{ warnings: [] }`.

**`POST /cdmresults/:sourceKey/conceptRecordCount` returned `[{ key, value }]`.**  
Atlas `CDMResultsAPI.js` does `densityIndex[Object.keys(entries[e])[0]] = Object.values(entries[e])[0]` — it expects `[{ [conceptId]: [rc, drc, pc, dpc] }]`. Wrong format meant record counts always showed 0 in vocabulary search and concept set displays. Column casing was also wrong (SQL uses lowercase `concept_id`; code was accessing `r.CONCEPT_ID`).  
*Fix:* Return `[{ [r.concept_id]: [r.record_count, r.descendant_record_count, 0, 0] }]`.

**`PUT /conceptset/:id/annotation` was missing (404).**  
Atlas calls this when the Annotation tab is active. Logged as errors but not user-blocking.  
*Fix:* Added stub returning `[]`.

**`POST /sqlrender/translate` was missing.**  
Atlas calls this after `POST /sql` to render the SQL in a selected dialect. Without it, the dialect buttons were silent no-ops.  
*Fix:* Added endpoint; passes SQL through for SQL Server, adds a comment for unsupported dialects.

**`POST /cohortdefinition/printfriendly/cohort` returned 501.**  
Atlas calls this whenever the Export tab is active (even when the user is on the SQL sub-tab). The 501 produced a console error on every export tab open.  
*Fix:* Returns minimal HTML placeholder instead of 501.

### Missing fields (found by systematic audit, lower impact)

| Endpoint | Missing fields | Effect |
|---|---|---|
| `GET /conceptset/:id`, `GET /cohortdefinition/:id` | `hasReadAccess: true` | May affect read-permission guards |
| `GET /cohortdefinition/:id/info` | `createdBy: null` | Atlas accesses `info.createdBy ? info.createdBy.login : null` — handles null, so no crash |
| `GET /cohortdefinition/:id/info` | `isDemographic` | Used for "view demographic" cohort display toggle |

---

## Why the Java DTO Audit Missed the Critical Bugs

The audit worked by reading Java class definitions and comparing field lists. That approach has a structural blind spot: **it tells you what fields a Java object can hold, but not how Jackson serializes it or what shape the HTTP response actually takes.**

The bugs that mattered most were not missing fields — they were format issues:

1. **`expression` as string vs object.** The Java `CohortDefinitionDTO` has a `String expression` field. Jackson serializes that as a JSON string literal (with quotes). Our DTO had `expression: JSON.parse(detail.expression)` (an object). The field name was right; the type was wrong. A field-name comparison won't catch this.

2. **`{ templateSql }` response envelope.** The Java `POST /sql` endpoint doesn't return a DTO that mirrors a single Java class — it returns a custom `{templateSql, options}` shape from a service method. The agent looked at DTO classes; this endpoint's shape lives in a service method body, not a class definition.

3. **`conceptRecordCount` array format.** Same issue: the Java response is built dynamically in a service, not from a DTO class. The agent never saw it.

4. **Missing endpoints.** The agent compared fields on endpoints we already had. It did not enumerate all Java endpoints and check which ones we were missing.

---

## How to Run a Better Comparison

The core insight: **read the Atlas JavaScript, not the Java server.** Atlas JS is the authoritative consumer. It tells you exactly what URL is called, what request body is sent, and which response fields are accessed — without any inference about Java serialization.

### Recommended approach for future audits

**Step 1 — Enumerate every WebAPI call Atlas makes.**  
In `Atlas/js/services/`, each `*API.js` or service file contains every `httpService.doGet/doPost/doPut` call. These are the ground truth for what URLs exist and what bodies/responses look like. A targeted grep of those files gives a complete endpoint list faster than reading Java route registrations.

**Step 2 — For each endpoint, trace response field access.**  
Search for where the service function's result is used in `pages/` or `components/`. Look for `result.data.someField`, `response.someField`, `data.map(item => item.FIELD)`. These pinpoint exactly which fields must exist and in what shape (string vs object, array of what, etc.).

**Step 3 — Compare against our implementation.**  
Read the corresponding route handler and match what we return against what Atlas reads.

This is slower per endpoint but catches format bugs that field-name comparison cannot.

### What actually works as a cross-check

| Method | Catches missing fields | Catches wrong format | Catches missing endpoints |
|---|---|---|---|
| Java DTO comparison | Yes | No | Partially |
| Atlas JS field-access tracing | Yes | Yes | Yes |
| Integration test (HTTP) | Yes | Yes | Yes |
| Network tab inspection during use | Yes (if you hit that code path) | Yes | Yes |

### On model size and effort

Model size is not the bottleneck. The audit that ran was capable; it was just pointed at the wrong artifact (Java class fields instead of Atlas JS call sites). A larger model reading Java DTOs would produce the same blind spot. The improvement is **what the agent reads**, not how smart it is.

If re-running the audit, the prompt should be:

> "Read every service file in Atlas/js/services/ and for each WebAPI call, record: (1) the HTTP method and URL pattern, (2) what fields are read from the response, and (3) what format those fields must be in (string, object, array shape). Then compare each against the corresponding handler in src/routes/."

That framing — consumer-first, format-aware — would have caught every bug listed above.

---

## Second Audit — 2026-06-16

The methodology above was applied for the first time. Six additional bugs were found and fixed.

### Critical — all Heracles cohort results returned 500

**`cohortresults.js` called `normKey()` (undefined) and `source.pool` (undefined).**  
`normKey` was used in `runDirectory` to key SQL file results but was never defined, causing `ReferenceError` on any endpoint that reads from directories of SQL files (observationperiod, death, heraclesheel, all domain drilldowns, cohort-specific). Separately, `runFile` called `source.pool` but pools are stored in a private `Map` accessible only via `getPool(sourceKey)` — the config source object has no `.pool` property.  
*Fix:* Define `normKey` (strips `sql` prefix, lowercases first char). Import `getPool` and use it inside `runFile`. Also fixed two inline `runSql(src.pool, sql)` calls.

**Same file: column casing bug in `analyses` and `distinctPersonCount` endpoints.**  
SQL queries produce lowercase column names (`analysis_id`, `count_value`); code accessed uppercase variants (`ANALYSIS_ID`, `COUNT_VALUE`), always returning `undefined`.  
*Fix:* Access `r.analysis_id`, `r.count_value`.

### High — vocabulary version always blank

**`GET /vocabulary/:sourceKey/info` returned `{ vocabularyVersion }` not `{ version }`.**  
`SourceAPI.js` reads `info.version` to display the vocabulary version in the Configuration screen. We returned `vocabularyVersion`. Field was always `undefined`; version badge always blank.  
*Fix:* Return `{ version, dialect }`.

### Medium — cohort definition version crashes on load

**`GET /cohortdefinition/:id/version/:ver` returned a flat DTO instead of `{ entityDTO, versionDTO }`.**  
`CohortDefinition.js:163-166` does `const cohortDef = res.data.entityDTO; cohortDef.expression = JSON.parse(cohortDef.expression)`. We returned a flat version DTO; `res.data.entityDTO` was `undefined`; accessing `.expression` on undefined threw `TypeError`.  
*Fix:* Return `{ entityDTO: { ...fullCohortDef, expression: versionRow.expression }, versionDTO: versionDto }`.

### Suspicious — not yet fixed

- **`source/details/:sourceKey` (BUG-6):** Our `GET /:key` route at `/source` cannot match a two-segment path. `SourceAPI.js` calls `GET source/details/:sourceKey` for the admin Source edit dialog → always 404. Admin-only; doesn't affect routine Atlas use.
- **`source/connection/:sourceKey` (SUSPECT-7):** Same structural issue. "Test Connection" button always returns 404.
- **`jobParameters.jobName` missing from generation job response (BUG-7):** Job name shows as blank in status panel. Visual only, no crash.

---

## Known Remaining Gaps

- `isDemographic` missing from generation info.
- Dialect translation in `/sqlrender/translate` is a pass-through for non-SQL-Server dialects.
- Vocabulary search does not include `PERSON_COUNT` / `DESCENDANT_PERSON_COUNT` (our concept count table only has record counts, not person counts from Achilles).
- Admin: `GET /source/details/:sourceKey` and `GET /source/connection/:sourceKey` missing (configuration screen only).
