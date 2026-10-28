-- Xsee database schema (SQLite)

CREATE TABLE IF NOT EXISTS teachers (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY,
  student_id TEXT NOT NULL UNIQUE,          -- school-issued student number
  full_name  TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS exams (
  id         INTEGER PRIMARY KEY,
  exam_name  TEXT NOT NULL,
  form_url   TEXT NOT NULL,
  form_id    TEXT NOT NULL UNIQUE,          -- id extracted from the Google Form link
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per student per exam: running totals so the summary is a single fast query.
CREATE TABLE IF NOT EXISTS sessions (
  id                 INTEGER PRIMARY KEY,
  exam_id            INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id         INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  last_seen          TEXT NOT NULL,
  status             TEXT NOT NULL,          -- ACTIVE AWAY IDLE NO_SIGNAL SUBMITTED CLOSED UNTRACKED
  prev_status        TEXT,                   -- status to restore after NO_SIGNAL
  tab_switch_count   INTEGER NOT NULL DEFAULT 0,
  idle_count         INTEGER NOT NULL DEFAULT 0,
  warning_count      INTEGER NOT NULL DEFAULT 0,
  total_away_seconds INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_id, student_id)
);

-- Append-only event history. exam_id is NULL for tracking on/off events done outside an exam.
CREATE TABLE IF NOT EXISTS logs (
  id           INTEGER PRIMARY KEY,
  event_id     TEXT NOT NULL UNIQUE,         -- client-generated UUID, makes retries idempotent
  exam_id      INTEGER REFERENCES exams(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  detail       TEXT,
  away_seconds INTEGER,
  client_time  TEXT,
  server_time  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_exam    ON logs (exam_id, student_id, id);
CREATE INDEX IF NOT EXISTS idx_logs_student ON logs (student_id, server_time);
CREATE INDEX IF NOT EXISTS idx_sessions_exam ON sessions (exam_id);
