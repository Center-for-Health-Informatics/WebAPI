CREATE TABLE IF NOT EXISTS ir_generation_info (
  ir_analysis_id     INTEGER NOT NULL,
  source_key         TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'PENDING',
  start_time         INTEGER,
  execution_duration INTEGER,
  fail_message       TEXT,
  created_by         TEXT,
  PRIMARY KEY (ir_analysis_id, source_key),
  FOREIGN KEY (ir_analysis_id) REFERENCES ir_analysis(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ir_analysis_result (
  ir_analysis_id INTEGER NOT NULL,
  source_key     TEXT    NOT NULL,
  target_id      INTEGER NOT NULL,
  outcome_id     INTEGER NOT NULL,
  total_persons  INTEGER NOT NULL DEFAULT 0,
  cases          INTEGER NOT NULL DEFAULT 0,
  time_at_risk   REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (ir_analysis_id, source_key, target_id, outcome_id),
  FOREIGN KEY (ir_analysis_id) REFERENCES ir_analysis(id) ON DELETE CASCADE
);
