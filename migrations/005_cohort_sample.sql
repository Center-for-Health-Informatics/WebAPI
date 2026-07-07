CREATE TABLE IF NOT EXISTS cohort_sample (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort_definition_id    INTEGER NOT NULL,
  source_key               TEXT NOT NULL,
  name                      TEXT NOT NULL,
  size                      INTEGER,
  age_mode                  TEXT,
  age_value                 INTEGER,
  age_min                   INTEGER,
  age_max                   INTEGER,
  gender_other_non_binary   INTEGER NOT NULL DEFAULT 0,
  gender_concept_ids        TEXT,
  elements                  TEXT,
  created_by                TEXT NOT NULL DEFAULT 'anonymous',
  modified_by               TEXT,
  created_date              INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  modified_date             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cohort_sample_lookup
  ON cohort_sample (cohort_definition_id, source_key);
