CREATE TABLE IF NOT EXISTS reusable (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  expression    TEXT,
  created_by    TEXT NOT NULL DEFAULT 'anonymous',
  modified_by   TEXT,
  created_date  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  modified_date INTEGER
);
