-- Cohort Pathways execution. Unlike ir_generation_info/ir_analysis_result
-- (keyed by analysis_id + source_key), Atlas's PathwayService addresses a
-- single execution by an opaque generationId (GET/POST .../generation/:id
-- and .../generation/:id/result) — so each run gets its own row here, and
-- the computed pathwayGroups/eventCodes report is cached as JSON since it's
-- immutable once generation completes.
CREATE TABLE IF NOT EXISTS pathway_generation (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  pathway_analysis_id INTEGER NOT NULL,
  source_key          TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'STARTED',
  start_time          INTEGER,
  end_time            INTEGER,
  hash_code           TEXT,
  fail_message        TEXT,
  result_json         TEXT,
  created_by          TEXT,
  FOREIGN KEY (pathway_analysis_id) REFERENCES pathway_analysis(id) ON DELETE CASCADE
);
