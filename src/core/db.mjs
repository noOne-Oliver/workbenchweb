import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(process.cwd());
// 账本跟着工作区走：设了 WB_ROOT 就是 <工作区>/data/ledger.db，否则是当前目录。
export const DB_PATH = resolve(process.env.WB_DB ?? resolve(process.env.WB_ROOT || ROOT, "data/ledger.db"));

/**
 * 打开账本。
 * events 是唯一真源，tasks 是物化投影（可从 events 全量重建）。
 */
export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 8000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,
      task_id   TEXT,
      type      TEXT NOT NULL,
      actor     TEXT NOT NULL,
      payload   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id);

    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      branch          TEXT,
      base_sha        TEXT,
      owner           TEXT NOT NULL,
      state           TEXT NOT NULL,
      lease_owner     TEXT,
      lease_expires_at INTEGER,
      budget_tokens   INTEGER NOT NULL DEFAULT 200000,
      spent_tokens    INTEGER NOT NULL DEFAULT 0,
      attempts        INTEGER NOT NULL DEFAULT 0,
      plan_md         TEXT,
      diff_stat       TEXT,
      evidence        TEXT,
      decision        TEXT NOT NULL DEFAULT 'pending',
      decision_note   TEXT,
      review_started_at INTEGER,
      review_seconds  INTEGER,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, created_at);

    CREATE TABLE IF NOT EXISTS users (
      name            TEXT PRIMARY KEY,
      role            TEXT NOT NULL DEFAULT 'member',
      password_hash   TEXT,
      secret_version  INTEGER NOT NULL DEFAULT 1,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);

  // 阶段链：项目 -> 阶段 -> 任务。项目和阶段是账本里的对象，不是界面上的标签，
  // 这样「这一批改动属于哪个目标、边界在哪」可以重放、可以审计。
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      lane            TEXT NOT NULL DEFAULT 'feature',
      workflow        TEXT NOT NULL,
      owner           TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'drafting',
      budget_tokens   INTEGER NOT NULL DEFAULT 1000000,
      meeting_budget  INTEGER NOT NULL DEFAULT 0,
      summary         TEXT,
      human_minutes   INTEGER,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stages (
      stage_id        TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      name            TEXT NOT NULL,
      goal            TEXT NOT NULL,
      role            TEXT NOT NULL,
      skill           TEXT,
      artifacts       TEXT NOT NULL DEFAULT '[]',
      allowed_globs   TEXT NOT NULL DEFAULT '[]',
      non_goals       TEXT NOT NULL DEFAULT '[]',
      state           TEXT NOT NULL DEFAULT 'proposed',
      signature_group TEXT NOT NULL DEFAULT 'A',
      task_id         TEXT,
      contract_md     TEXT,
      started_at      TEXT,
      ended_at        TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stages_project ON stages(project_id, seq);

    CREATE TABLE IF NOT EXISTS backlog (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      stage_id    TEXT,
      text        TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'agent',
      status      TEXT NOT NULL DEFAULT 'open',
      decided_by  TEXT,
      decided_at  TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signatures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      group_name  TEXT NOT NULL,
      covers      TEXT NOT NULL,
      by          TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL
    );
  `);

  addColumn(db, "tasks", "project_id", "TEXT");
  addColumn(db, "tasks", "stage_id", "TEXT");

  // 两段评审（初筛 / 终审）新增的列。老库直接 ALTER，新库在这里补齐。
  addColumn(db, "tasks", "reviewer", "TEXT");
  addColumn(db, "tasks", "review_lease_expires_at", "INTEGER");
  addColumn(db, "tasks", "first_reviewed_by", "TEXT");
  addColumn(db, "tasks", "first_reviewed_at", "TEXT");
  addColumn(db, "tasks", "approval_started_at", "INTEGER");
  addColumn(db, "tasks", "approval_seconds", "INTEGER");
  addColumn(db, "tasks", "approved_by", "TEXT");
  addColumn(db, "tasks", "approved_at", "TEXT");
  addColumn(db, "tasks", "self_approved", "INTEGER NOT NULL DEFAULT 0");
}

function addColumn(db, table, column, type) {
  const cols = db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => c.name);
  if (!cols.includes(column)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
}