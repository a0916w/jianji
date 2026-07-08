// lib/db.js —— SQLite 任务库(better-sqlite3,同步)。JSON 字段(media/tags/edit_spec)存 TEXT 列。
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const JSON_COLS = ['media', 'tags', 'edit_spec'];

function createDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // 防御性兜底：即便未走 IMMEDIATE 分支也不会立即抛 SQLITE_BUSY
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_chat_id TEXT, tg_message_id TEXT, media_group TEXT,
    media TEXT, title TEXT, description TEXT, tags TEXT,
    mode TEXT, edit_spec TEXT, status TEXT,
    probe_w INTEGER, probe_h INTEGER,
    result_path TEXT, error TEXT,
    created_at TEXT, updated_at TEXT
  )`);

  const now = () => new Date().toISOString();
  const ser = (v) => (v === undefined ? null : JSON.stringify(v));
  function rowToJob(row) {
    if (!row) return null;
    const job = { ...row, id: String(row.id) };
    for (const c of JSON_COLS) job[c] = row[c] == null ? (c === 'edit_spec' ? null : []) : JSON.parse(row[c]);
    return job;
  }

  function create(fields) {
    const t = now();
    const info = db.prepare(`INSERT INTO jobs
      (tg_chat_id,tg_message_id,media_group,media,title,description,tags,mode,edit_spec,status,probe_w,probe_h,result_path,error,created_at,updated_at)
      VALUES (@tg_chat_id,@tg_message_id,@media_group,@media,@title,@description,@tags,@mode,@edit_spec,@status,@probe_w,@probe_h,@result_path,@error,@created_at,@updated_at)`)
      .run({
        tg_chat_id: fields.tg_chat_id ?? null, tg_message_id: fields.tg_message_id != null ? String(fields.tg_message_id) : null,
        media_group: fields.media_group ?? null, media: ser(fields.media ?? []),
        title: fields.title ?? null, description: fields.description ?? null, tags: ser(fields.tags ?? []),
        mode: fields.mode ?? 'manual', edit_spec: ser(fields.edit_spec ?? null),
        status: fields.status ?? 'downloading', probe_w: fields.probe_w ?? null, probe_h: fields.probe_h ?? null,
        result_path: fields.result_path ?? null, error: fields.error ?? null, created_at: t, updated_at: t,
      });
    return get(String(info.lastInsertRowid));
  }
  function get(id) {
    return rowToJob(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  }
  function update(id, patch) {
    const cur = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!cur) throw new Error('job 不存在: ' + id);
    const cols = [], vals = {};
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k}=@${k}`);
      vals[k] = JSON_COLS.includes(k) ? ser(v) : v;
    }
    cols.push('updated_at=@updated_at'); vals.updated_at = now(); vals.id = id;
    db.prepare(`UPDATE jobs SET ${cols.join(',')} WHERE id=@id`).run(vals);
    return get(id);
  }
  function listByStatus(status) {
    return db.prepare('SELECT * FROM jobs WHERE status=? ORDER BY created_at').all(status).map(rowToJob);
  }
  // 原子领取:一条事务内选最早的 fromStatus 并置 toStatus
  // 用 IMMEDIATE 事务(而非默认 deferred)立刻拿写锁：避免多进程并发领取时
  // SELECT(读快照)之后升级为 UPDATE(写)与另一进程的写事务冲突，抛出未捕获的
  // SqliteError: database is locked (SQLITE_BUSY) 拖垮进程。
  const _claimTxn = db.transaction((fromStatus, toStatus) => {
    const row = db.prepare('SELECT id FROM jobs WHERE status=? ORDER BY created_at LIMIT 1').get(fromStatus);
    if (!row) return null;
    db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(toStatus, now(), row.id);
    return get(String(row.id));
  });
  function claimNext(fromStatus, toStatus) { return _claimTxn.immediate(fromStatus, toStatus); }

  return { create, get, update, listByStatus, claimNext, _db: db };
}
module.exports = { createDb };
