CREATE TABLE IF NOT EXISTS tool (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  url          TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT NOT NULL DEFAULT 'anonymous',
  modified_by  TEXT,
  created_date  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  modified_date INTEGER
);
