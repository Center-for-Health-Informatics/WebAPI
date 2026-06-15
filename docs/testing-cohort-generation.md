# Atlas Cohort Generation — Manual Test Script

## Background (developer framing)

A **cohort definition** is essentially a query over the OMOP CDM that identifies a set of patients and the date range during which they're "in" the cohort. CIRCE compiles the definition JSON into T-SQL that populates the `cohort` table: `(cohort_definition_id, subject_id, cohort_start_date, cohort_end_date)`. The pipeline is: Atlas UI → WebAPI → CIRCE JAR → SQL Server → cohort table.

## Prerequisites

- Atlas open in browser
- WebAPI running with `docker compose logs --follow` in a terminal
- At least one CDM source connected

---

## Test 1 — Minimal cohort (smoke test, no concept needed)

"Any visit" means every patient with at least one row in `visit_occurrence` qualifies, so the result will be a large, predictable number.

1. In Atlas, click **Cohort Definitions** in the left nav → **New Cohort**
2. Give it a name like `Test - Any Visit`
3. Under **Cohort Entry Events**, click **Add Initial Event** → select **Visit Occurrence**
4. Leave all filters at defaults (no concept set required, no date constraints)
5. Under **Cohort Exit**, leave it at the default (end of continuous observation)
6. Click **Save** (disk icon, top right)
7. Click the **Generate** tab → click **Generate** next to your source name

**In the logs, you should see:**
```
[cohort 1@yourSourceKey] Generating SQL...
[cohort 1@yourSourceKey] Executing...
[cohort 1@yourSourceKey] COMPLETED: NNN persons, NNN records (NNNms)
```

**In Atlas**, the status badge should change from `PENDING` → `RUNNING` → `COMPLETE`. The person count should match the number of distinct patients in your CDM who have any visit.

---

## Test 2 — Condition-based cohort (more realistic)

This tests that concept sets work (the `#Codesets` temp table CIRCE generates). Pick any diagnosis you know is present in the CDM. If you're not sure, use something common like "Type 2 diabetes mellitus."

1. In Atlas, click **Concept Sets** → **New Concept Set**
2. Name it `Type 2 Diabetes`
3. Click the search icon → search for `Type 2 diabetes mellitus`
4. Find the row with **Standard** = `S` (green) and **Domain** = `Condition` → click the `+` button
5. Check **Descendants** ✓ (this includes all child concepts, e.g. "T2DM with complications") → **Save**
6. Back in **Cohort Definitions** → **New Cohort**
7. Name it `Test - T2DM Patients`
8. Under **Cohort Entry Events** → **Add Initial Event** → **Condition Occurrence**
9. Click **Add Codes from Concept Set** → select your `Type 2 Diabetes` set
10. **Save** → **Generate** tab → **Generate**

**Expected in logs:** Same pattern as Test 1 but a smaller person count.

**If person count is 0:** Either the concept isn't in the CDM, or the descendants didn't expand to concepts actually present. Try a different condition — use the Atlas CDM Results data explorer (Data Sources → your source → Condition domain) to see what's present.

---

## Test 3 — SQL preview (tests `POST /sql`)

This verifies the SQL endpoint independently of execution.

1. Open any saved cohort definition
2. Click the **\</> SQL** tab (or "View SQL" button — the label varies by Atlas version)

**What to look for:** A multi-hundred-line SQL block starting with:
```sql
CREATE TABLE #Codesets (
  codeset_id int NOT NULL,
  concept_id bigint NOT NULL
)
```
…and ending with `DROP TABLE #Codesets;`

If you see a 400 or 500 error in the logs instead, the CIRCE JAR invocation failed.

---

## Test 4 — Re-generate (idempotency check)

Click **Generate** a second time on any cohort that already completed. It should re-run cleanly — the old rows in the `cohort` table are deleted and re-inserted, and the status in `cohort_generation_info` resets to STARTED then COMPLETED again. Person count should be the same.

---

## Things to watch in the logs

| Log message | Meaning |
|---|---|
| `[cohort N@key] Generating SQL...` | CIRCE JAR spawned |
| `[cohort N@key] Executing...` | SQL sent to SQL Server |
| `[cohort N@key] COMPLETED: X persons` | All done |
| `[cohort N@key] FAILED: ...` | Error — the message will say what went wrong |
| `CIRCE exit 1: ...` | JAR crashed — likely malformed expression JSON |
| `Invalid object name...` | SQL Server can't find a table (wrong schema config) |
| `Timeout` | Cohort query exceeded a SQL Server-side limit |

---

## Interpreting results

The `person_count` and `record_count` in the Atlas UI map directly to:

```sql
COUNT(DISTINCT subject_id)  -- persons
COUNT(*)                    -- records (one person can have multiple cohort periods)
```

`record_count >= person_count` always. They're equal when the collapse settings merge all of a patient's periods into one (ERA collapse). They differ when a patient re-qualifies multiple times and the collapse window doesn't merge the periods.
