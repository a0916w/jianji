# jianji 剪辑服务 Phase 1（manual 模式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Telegram 群发来的相册（多视频+多图+说明）经 jianji 页面人工剪辑后，由服务端 ffmpeg 后台渲染成一条视频、发回群。

**Architecture:** 单个 Node 进程：HTTP 服务（剪辑页 + 提交接口）+ Telegram bot 长轮询（收相册/下载/回传）+ 后台 worker（取任务→ffmpeg 渲染→回传）。任务状态存 JSON 文件（单进程、低吞吐，零依赖；schema 对齐 spec 的 jobs 表，量大可换 SQLite）。复用 fengmiantu 的工具函数。

**Tech Stack:** Node（零 npm 依赖）、本机 ffmpeg/ffprobe、JSON 文件存储、Telegram Bot API（getUpdates 长轮询）。

## Global Constraints

- 依赖极简：仅一个 npm 依赖 `better-sqlite3`（SQLite,同步 API）；其余只用 Node 内置模块 + 本机 ffmpeg/ffprobe（`spawn`/`execFile`）。部署时 `npm install --omit=dev`。
- 运行环境：AWS 18.163.100.253，与 fengmiantu 同机不同端口（本服务默认 `PORT=3001`）。
- 非 root 运行；秘钥走 env（`TELEGRAM_BOT_TOKEN` 等），不写进代码/仓库。
- 剪辑链接 HMAC 签名：`sign = hmac_sha256(jobId, SIGN_SECRET)`，`SIGN_SECRET` 来自 env。
- 所有 ffmpeg 调用复用 fengmiantu 的 `run(cmd,args,timeoutMs)`（execFile 封装）。
- 目录约定：`WORK_DIR/<jobId>/`（下载媒体 + 成品），`DB_PATH`（jobs JSON）。
- 默认参数（复刻 jianji）：图片静帧 `DEFAULT_IMAGE_DUR=3`s、视频段 `DEFAULT_SEG_LEN=5`s、转场 `DEFAULT_FADE=0.35`s、比例 `DEFAULT_ASPECT=auto`（跟随首视频）。
- 代码放 jianji 仓库根：`server.js`（主）、`lib/*.js`（各单元）、`index.html`（改造）。

---

## 文件结构

- Create `lib/util.js` — 从 fengmiantu 移植的通用函数（run/readJsonBody/sendJson/httpGet/httpPostJson）。
- Create `lib/db.js` — SQLite(better-sqlite3)任务库（建表 + create/get/update/listByStatus/claimNext）。
- Create `lib/caption.js` — 解析相册 caption（格式A）→ {title,description,tags}。
- Create `lib/sign.js` — HMAC 签名/校验。
- Create `lib/smartcut.js` — 服务端复刻智能选段（ffmpeg 抽帧算运动量选最大窗口）。
- Create `lib/render.js` — 按 edit_spec 用 ffmpeg 合成成片。
- Create `lib/telegram.js` — bot 长轮询、相册聚合、下载媒体、发消息/视频。
- Create `worker.js` — 后台循环：claimNext(rendering) → render → 回传 → done/failed。
- Create `server.js` — HTTP：`/edit` 剪辑页、`GET /api/job`、`POST /api/submit`、静态；装配 telegram 轮询 + 启动 worker。
- Modify `index.html` — 从 `?job=&sign=` 拉媒体预加载；「生成」改为 POST edit_spec 到 `/api/submit`（不再本地 MediaRecorder 导出）。
- Create `test/*.test.js` — 各单元 node 内置断言测试。
- Create `deploy.sh` — 一键部署（对齐 fengmiantu：env 文件 600 + systemd 非 root）。

数据模型（`lib/db.js` 每条 job，对齐 spec）：
```
{ id, tg_chat_id, tg_message_id, media_group,
  media: [{type:'video'|'image', path, tg_file_id}],
  title, description, tags:[], mode:'manual',
  edit_spec: {aspect, segLen, fade, clips:[{index,start,end,order}]} | null,
  status: 'downloading'|'editing'|'rendering'|'done'|'failed',
  result_path, error, created_at, updated_at }
```

---

### Task 1: 通用工具 lib/util.js

**Files:**
- Create: `lib/util.js`
- Test: `test/util.test.js`

**Interfaces:**
- Produces:
  - `run(cmd, args, timeoutMs=120000) -> Promise<{stdout,stderr}>`（execFile 封装，失败 reject 且 err.stderr 带 stderr）
  - `readJsonBody(req, maxBytes=8*1024*1024) -> Promise<object>`
  - `sendJson(res, code, obj) -> void`
  - `httpGet(url, timeoutMs=30000) -> Promise<{status, buffer:Buffer}>`（http/https 自适应，返回二进制 body）
  - `httpPostJson(url, obj, timeoutMs=20000) -> Promise<{status, body:string}>`

- [ ] **Step 1: 写失败测试**

```js
// test/util.test.js
const assert = require('node:assert');
const { sendJson, httpGet, run } = require('../lib/util');
const http = require('http');

(async () => {
  // sendJson 写正确 header + body
  let written = {};
  const fakeRes = { writeHead:(c,h)=>{written.code=c;written.h=h;}, end:(b)=>{written.body=b;} };
  sendJson(fakeRes, 200, { ok: true });
  assert.strictEqual(written.code, 200);
  assert.strictEqual(written.body, '{"ok":true}');

  // httpGet 拿到二进制
  const srv = http.createServer((q,s)=>{ s.writeHead(200); s.end(Buffer.from([1,2,3])); }).listen(34310);
  const g = await httpGet('http://127.0.0.1:34310/x');
  assert.strictEqual(g.status, 200);
  assert.ok(Buffer.isBuffer(g.buffer) && g.buffer.length === 3);
  srv.close();

  // run 执行 echo
  const r = await run('echo', ['hi'], 5000);
  assert.match(r.stdout, /hi/);
  console.log('UTIL_OK');
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/util.test.js`
Expected: FAIL（Cannot find module '../lib/util'）

- [ ] **Step 3: 实现 lib/util.js**

```js
// lib/util.js
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > maxBytes) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function httpGet(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http get timeout')));
  });
}

function httpPostJson(url, obj, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    const body = Buffer.from(JSON.stringify(obj));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: timeoutMs },
      (resp) => { let d = ''; resp.on('data', (c) => d += c); resp.on('end', () => resolve({ status: resp.statusCode, body: d })); });
    req.on('timeout', () => req.destroy(new Error('post timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { run, readJsonBody, sendJson, httpGet, httpPostJson };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/util.test.js`
Expected: 打印 `UTIL_OK`，退出 0

- [ ] **Step 5: 提交**

```bash
git add lib/util.js test/util.test.js
git commit -m "feat(util): 通用工具(run/httpGet/httpPostJson/sendJson/readJsonBody)"
```

---

### Task 2: caption 解析 lib/caption.js

**Files:**
- Create: `lib/caption.js`
- Test: `test/caption.test.js`

**Interfaces:**
- Produces: `parseCaption(text:string) -> {title:string, description:string, tags:string[]}`
  - 首行非空 = title；其余非 `#` 行拼成 description（去掉标签行）；所有 `#词` 收集为 tags（去 `#`、去重）。

- [ ] **Step 1: 写失败测试**

```js
// test/caption.test.js
const assert = require('node:assert');
const { parseCaption } = require('../lib/caption');

const r = parseCaption('绝世高手回归\n男主隐藏身份三年后霸气归来\n#热血 #逆袭 #热血');
assert.strictEqual(r.title, '绝世高手回归');
assert.strictEqual(r.description, '男主隐藏身份三年后霸气归来');
assert.deepStrictEqual(r.tags, ['热血', '逆袭']); // 去重

const empty = parseCaption('');
assert.strictEqual(empty.title, '');
assert.deepStrictEqual(empty.tags, []);

const onlyTitle = parseCaption('单标题');
assert.strictEqual(onlyTitle.title, '单标题');
assert.strictEqual(onlyTitle.description, '');
console.log('CAPTION_OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/caption.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lib/caption.js**

```js
// lib/caption.js
function parseCaption(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const tags = [];
  const seen = new Set();
  for (const m of raw.matchAll(/#([^\s#]+)/g)) {
    const t = m[1];
    if (!seen.has(t)) { seen.add(t); tags.push(t); }
  }
  const lines = raw.split('\n');
  const title = (lines[0] || '').trim();
  const descLines = lines.slice(1)
    .map((l) => l.replace(/#[^\s#]+/g, '').trim()) // 去掉行内标签
    .filter((l) => l !== '');
  return { title, description: descLines.join('\n'), tags };
}

module.exports = { parseCaption };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/caption.test.js`
Expected: `CAPTION_OK`

- [ ] **Step 5: 提交**

```bash
git add lib/caption.js test/caption.test.js
git commit -m "feat(caption): 相册说明解析(首行标题/描述/#标签,去重)"
```

---

### Task 3: 签名 lib/sign.js

**Files:**
- Create: `lib/sign.js`
- Test: `test/sign.test.js`

**Interfaces:**
- Produces:
  - `sign(id:string) -> string`（hmac_sha256(id, SIGN_SECRET) hex）
  - `verify(id:string, sig:string) -> boolean`（时序安全比较）

- [ ] **Step 1: 写失败测试**

```js
// test/sign.test.js
process.env.SIGN_SECRET = 'test-secret';
const assert = require('node:assert');
const { sign, verify } = require('../lib/sign');

const s = sign('job-1');
assert.strictEqual(typeof s, 'string');
assert.ok(verify('job-1', s));
assert.ok(!verify('job-1', 'deadbeef'));
assert.ok(!verify('job-2', s));
console.log('SIGN_OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/sign.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lib/sign.js**

```js
// lib/sign.js
const crypto = require('crypto');

function secret() {
  const s = process.env.SIGN_SECRET || '';
  if (!s) throw new Error('SIGN_SECRET 未配置');
  return s;
}
function sign(id) {
  return crypto.createHmac('sha256', secret()).update(String(id)).digest('hex');
}
function verify(id, sig) {
  const expected = sign(id);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { sign, verify };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/sign.test.js`
Expected: `SIGN_OK`

- [ ] **Step 5: 提交**

```bash
git add lib/sign.js test/sign.test.js
git commit -m "feat(sign): HMAC 剪辑链接签名/校验(时序安全)"
```

---

### Task 4: 任务库 lib/db.js（SQLite / better-sqlite3）

**Files:**
- Create: `package.json`（声明依赖 better-sqlite3）
- Create: `lib/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces（构造 `createDb(dbPath)` 返回对象；对外暴露的 job 是 JS 对象,media/tags/edit_spec 已解析）:
  - `create(fields:object) -> job`（自增 id 转字符串、created/updated、status 默认 'downloading'；media/tags/edit_spec 序列化存 TEXT 列）
  - `get(id) -> job|null`（反序列化 media/tags/edit_spec）
  - `update(id, patch:object) -> job`（合并 patch + updated_at；patch 里若含 media/tags/edit_spec 自动序列化）
  - `listByStatus(status) -> job[]`
  - `claimNext(fromStatus, toStatus) -> job|null`（单条 SQL 事务:选最早一条 fromStatus、置为 toStatus,原子,供 worker 防重复领取）

**说明:** better-sqlite3 是同步 API,天然契合 worker 的取-改-写；WAL 模式 + 单条 UPDATE...WHERE id=(SELECT... LIMIT 1) 保证 claimNext 原子。

- [ ] **Step 1: 建 package.json + 装依赖**

```json
{
  "name": "jianji-service",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "dependencies": { "better-sqlite3": "^11.0.0" }
}
```

Run: `npm install`
Expected: 生成 node_modules/better-sqlite3（Ubuntu/常见平台有预编译二进制；若无则自动 node-gyp 编译,需 python3+make+g++）。

- [ ] **Step 2: 写失败测试**

```js
// test/db.test.js
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createDb } = require('../lib/db');

const p = path.join(os.tmpdir(), 'jj-db-' + Date.now() + '.sqlite');
const db = createDb(p);

const j = db.create({ tg_chat_id: 'c', media: [{ type: 'image', path: '/a.jpg' }], tags: ['x'], mode: 'manual' });
assert.ok(j.id);
assert.strictEqual(j.status, 'downloading');
const got = db.get(j.id);
assert.strictEqual(got.tg_chat_id, 'c');
assert.deepStrictEqual(got.media, [{ type: 'image', path: '/a.jpg' }]); // JSON 列已解析回对象
assert.deepStrictEqual(got.tags, ['x']);

db.update(j.id, { status: 'rendering', edit_spec: { aspect: 'auto', clips: [] } });
assert.strictEqual(db.get(j.id).status, 'rendering');
assert.deepStrictEqual(db.get(j.id).edit_spec, { aspect: 'auto', clips: [] });
assert.strictEqual(db.listByStatus('rendering').length, 1);

// 持久化：新实例能读回
const db2 = createDb(p);
assert.strictEqual(db2.get(j.id).status, 'rendering');

// claimNext 原子迁移状态
const claimed = db2.claimNext('rendering', 'processing');
assert.strictEqual(claimed.id, j.id);
assert.strictEqual(db2.get(j.id).status, 'processing');
assert.strictEqual(db2.claimNext('rendering', 'processing'), null);

fs.unlinkSync(p);
console.log('DB_OK');
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node test/db.test.js`
Expected: FAIL（模块 '../lib/db' 不存在）

- [ ] **Step 4: 实现 lib/db.js**

```js
// lib/db.js —— SQLite 任务库(better-sqlite3,同步)。JSON 字段(media/tags/edit_spec)存 TEXT 列。
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const JSON_COLS = ['media', 'tags', 'edit_spec'];

function createDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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
  const claimTxn = db.transaction((fromStatus, toStatus) => {
    const row = db.prepare('SELECT id FROM jobs WHERE status=? ORDER BY created_at LIMIT 1').get(fromStatus);
    if (!row) return null;
    db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(toStatus, now(), row.id);
    return get(String(row.id));
  });
  function claimNext(fromStatus, toStatus) { return claimTxn(fromStatus, toStatus); }

  return { create, get, update, listByStatus, claimNext, _db: db };
}
module.exports = { createDb };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/db.test.js`
Expected: `DB_OK`

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json lib/db.js test/db.test.js
git commit -m "feat(db): SQLite 任务库(better-sqlite3,WAL,JSON列,原子claimNext)"
```

---

### Task 5: 智能选段 lib/smartcut.js

**Files:**
- Create: `lib/smartcut.js`
- Test: `test/smartcut.test.js`

**Interfaces:**
- Produces:
  - `pickSegment(scores:number[], times:number[], segLen:number, duration:number) -> {start,end}`（纯函数：滑窗选运动量最大区间，复刻 jianji）
  - `smartSegmentForVideo(videoPath, segLen, {run, ffprobeDuration}) -> Promise<{start,end}>`（抽帧算差 → pickSegment；依赖注入便于测试）

**说明:** 纯算法 `pickSegment` 用单测覆盖（不碰 ffmpeg）；`smartSegmentForVideo` 的 ffmpeg 抽帧+算差逻辑在 Task 8 集成时用真实短视频验证。

- [ ] **Step 1: 写失败测试（纯算法）**

```js
// test/smartcut.test.js
const assert = require('node:assert');
const { pickSegment } = require('../lib/smartcut');

// times/scores：区间 [2,3] 运动量最大
const times = [0,1,2,3,4];
const scores = [1,1,9,9,1];
const seg = pickSegment(scores, times, 2, 10);
assert.strictEqual(seg.start, 2);
assert.strictEqual(seg.end, 4);

// 全片短于 segLen：返回 [0,duration]（由调用方处理，此处窗口不越界）
const seg2 = pickSegment([5], [0], 2, 1);
assert.ok(seg2.start >= 0 && seg2.end <= 2);
console.log('SMARTCUT_OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/smartcut.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lib/smartcut.js**

```js
// lib/smartcut.js —— 复刻 jianji：抽帧算相邻帧像素差(运动量),滑窗选最大 segLen 区间。
function pickSegment(scores, times, segLen, duration) {
  let bestStart = 0, bestScore = -1;
  for (let i = 0; i < times.length; i++) {
    const winStart = times[i];
    if (winStart + segLen > duration) break;
    let sum = 0;
    for (let j = i; j < times.length && times[j] <= winStart + segLen; j++) sum += scores[j];
    if (sum > bestScore) { bestScore = sum; bestStart = winStart; }
  }
  return { start: bestStart, end: Math.min(duration, bestStart + segLen) };
}

// 抽帧算差：用 ffmpeg 均匀抽 n 张缩略图到内存(pipe)难,改抽到临时目录再逐张比。
// deps.run = util.run; deps.readFrames(videoPath,n) -> Promise<Buffer[]>(灰度小图字节)
async function smartSegmentForVideo(videoPath, segLen, deps) {
  const duration = await deps.ffprobeDuration(videoPath);
  if (!duration || duration <= segLen + 0.3) return { start: 0, end: duration || segLen };
  const n = Math.min(30, Math.max(10, Math.floor(duration * 2)));
  const frames = await deps.readFrames(videoPath, n); // Buffer[]，等间隔 n 帧的原始灰度像素
  const times = [], scores = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i], b = frames[i - 1];
    let diff = 0;
    const len = Math.min(a.length, b.length);
    for (let p = 0; p < len; p += 8) diff += Math.abs(a[p] - b[p]);
    scores.push(diff);
    times.push(duration * i / (n - 1));
  }
  return pickSegment(scores, times, segLen, duration);
}

module.exports = { pickSegment, smartSegmentForVideo };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/smartcut.test.js`
Expected: `SMARTCUT_OK`

- [ ] **Step 5: 提交**

```bash
git add lib/smartcut.js test/smartcut.test.js
git commit -m "feat(smartcut): 复刻 jianji 智能选段(pickSegment 纯算法 + 抽帧驱动)"
```

---

### Task 6: 渲染 lib/render.js

**Files:**
- Create: `lib/render.js`
- Test: `test/render.test.js`

**Interfaces:**
- Produces:
  - `buildFfmpegArgs(job, outPath, defaults) -> {args:string[]}`（纯函数：把 job.media + edit_spec 翻译成 ffmpeg 参数；无副作用，单测覆盖）
  - `render(job, outPath, deps) -> Promise<string>`（调 `deps.run('ffmpeg', args)` 真渲染，返回 outPath；Task 8 用真实素材验证）

**渲染规则（对齐 spec/jianji）:** 每段归一化到目标分辨率（scale + pad 保比例）+ 统一 fps/SAR；图片段 `-loop 1 -t <imageDur>`；视频段 `-ss start -to end`；段间 `xfade` 0.35s + 音频 `acrossfade`；输出 H.264 mp4。目标分辨率：aspect=auto 时用首个视频尺寸（job 里带 `probe_w/probe_h`），否则用选定档位。

- [ ] **Step 1: 写失败测试（纯参数构造）**

```js
// test/render.test.js
const assert = require('node:assert');
const { buildFfmpegArgs } = require('../lib/render');

const job = {
  media: [
    { type: 'image', path: '/w/1/a.jpg' },
    { type: 'video', path: '/w/1/b.mp4' },
  ],
  edit_spec: {
    aspect: '720x1280', segLen: 5, fade: 0.35,
    clips: [
      { index: 0, order: 0 },                    // 图片
      { index: 1, start: 2, end: 7, order: 1 },  // 视频段
    ],
  },
};
const { args } = buildFfmpegArgs(job, '/w/1/out.mp4', { imageDur: 3 });
const s = args.join(' ');
// 两个输入都在
assert.ok(s.includes('/w/1/a.jpg'));
assert.ok(s.includes('/w/1/b.mp4'));
// 图片 loop + 时长 3
assert.ok(s.includes('-loop 1'));
assert.ok(s.includes('-t 3'));
// 视频截取
assert.ok(s.includes('-ss 2'));
// 输出分辨率进了 scale/pad 滤镜
assert.ok(s.includes('720') && s.includes('1280'));
// 输出路径在最后
assert.strictEqual(args[args.length - 1], '/w/1/out.mp4');
console.log('RENDER_OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/render.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lib/render.js**

```js
// lib/render.js —— job.media + edit_spec → ffmpeg 参数。
function parseAspect(job, defaults) {
  const a = job.edit_spec?.aspect || 'auto';
  if (a === 'auto') {
    const w = job.probe_w || 720, h = job.probe_h || 1280;
    return { w, h };
  }
  const m = /^(\d+)x(\d+)$/.exec(a);
  return m ? { w: +m[1], h: +m[2] } : { w: 720, h: 1280 };
}

function buildFfmpegArgs(job, outPath, defaults = {}) {
  const imageDur = defaults.imageDur || 3;
  const fade = job.edit_spec?.fade ?? 0.35;
  const { w, h } = parseAspect(job, defaults);
  const clips = (job.edit_spec?.clips || []).slice().sort((a, b) => a.order - b.order);

  const inputs = [];
  const filters = [];
  const labels = [];
  clips.forEach((c, i) => {
    const m = job.media[c.index];
    if (m.type === 'image') {
      inputs.push('-loop', '1', '-t', String(imageDur), '-i', m.path);
    } else {
      inputs.push('-ss', String(c.start ?? 0), '-to', String(c.end ?? (c.start ?? 0) + (job.edit_spec?.segLen || 5)), '-i', m.path);
    }
    // 归一化：缩放进画布 + 补边 + 统一 sar/fps
    filters.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`
    );
    labels.push(`[v${i}]`);
  });

  // 段间 xfade 串联（简化：无音频交叉，图片段静音由 ffmpeg 处理；音频后续增强）
  let filterComplex;
  if (labels.length === 1) {
    filterComplex = filters.join(';') + `;${labels[0]}copy[vout]`;
  } else {
    let cur = labels[0];
    const chain = [];
    let offset = 0;
    clips.forEach((c, i) => {
      if (i === 0) return;
      const dur = c.index != null && job.media[c.index]?.type === 'image'
        ? imageDur
        : ((c.end ?? 0) - (c.start ?? 0)) || (job.edit_spec?.segLen || 5);
      const prevDur = i === 1
        ? (job.media[clips[0].index]?.type === 'image' ? imageDur : ((clips[0].end ?? 0) - (clips[0].start ?? 0)))
        : dur;
      offset += (i === 1 ? prevDur : dur) - fade;
      const out = i === labels.length - 1 ? '[vout]' : `[x${i}]`;
      chain.push(`${cur}${labels[i]}xfade=transition=fade:duration=${fade}:offset=${Math.max(0, offset).toFixed(3)}${out}`);
      cur = out;
    });
    filterComplex = filters.concat(chain).join(';');
  }

  return {
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-movflags', '+faststart',
      outPath,
    ],
  };
}

async function render(job, outPath, deps) {
  const { args } = buildFfmpegArgs(job, outPath, deps.defaults || {});
  await deps.run('ffmpeg', args, deps.timeoutMs || 600000);
  return outPath;
}

module.exports = { buildFfmpegArgs, render };
```

> 注：音频交叉（acrossfade）先略，Phase 1 出成片以画面为主；集成（Task 8）真跑素材时若成片无声或对不齐，在本文件补 `-map` 音频 + `acrossfade`，作为该任务内的修正步骤。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/render.test.js`
Expected: `RENDER_OK`

- [ ] **Step 5: 提交**

```bash
git add lib/render.js test/render.test.js
git commit -m "feat(render): edit_spec→ffmpeg 参数(图片loop/视频截取/scale-pad/xfade)"
```

---

### Task 7: Telegram lib/telegram.js（相册聚合 + 收发）

**Files:**
- Create: `lib/telegram.js`
- Test: `test/telegram.test.js`

**Interfaces:**
- Produces:
  - `groupUpdates(updates:object[]) -> Array<{chat_id, message_id, media_group, items:[{type,file_id}], caption}>`（纯函数：把 getUpdates 的消息按 media_group_id 聚合成相册批次；单测覆盖）
  - `createBot(token, {httpGet, httpPostJson}) -> { getUpdates(offset), getFileUrl(file_id), sendMessage(chat_id, text), sendVideo(chat_id, path, caption) }`（Task 8 集成用真实 token 手测）

- [ ] **Step 1: 写失败测试（聚合逻辑）**

```js
// test/telegram.test.js
const assert = require('node:assert');
const { groupUpdates } = require('../lib/telegram');

const updates = [
  { message: { chat: { id: 10 }, message_id: 100, media_group_id: 'g1', caption: '标题\n#a',
      photo: [{ file_id: 'p_small' }, { file_id: 'p_big' }] } },
  { message: { chat: { id: 10 }, message_id: 101, media_group_id: 'g1',
      video: { file_id: 'v1' } } },
  { message: { chat: { id: 10 }, message_id: 102, media_group_id: 'g2',
      video: { file_id: 'v2' }, caption: '另一个' } },
];
const batches = groupUpdates(updates);
assert.strictEqual(batches.length, 2);
const g1 = batches.find(b => b.media_group === 'g1');
assert.strictEqual(g1.items.length, 2);
// 图片取最大尺寸那个 file_id
assert.ok(g1.items.some(it => it.type === 'image' && it.file_id === 'p_big'));
assert.ok(g1.items.some(it => it.type === 'video' && it.file_id === 'v1'));
assert.strictEqual(g1.caption, '标题\n#a'); // caption 取相册里有 caption 的那条
console.log('TG_OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/telegram.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lib/telegram.js**

```js
// lib/telegram.js
function groupUpdates(updates) {
  const byGroup = new Map();
  const singles = [];
  for (const u of updates) {
    const m = u.message; if (!m) continue;
    let item = null;
    if (m.video) item = { type: 'video', file_id: m.video.file_id };
    else if (m.photo && m.photo.length) item = { type: 'image', file_id: m.photo[m.photo.length - 1].file_id }; // 最大尺寸
    else if (m.document && /video|image/.test(m.document.mime_type || '')) item = { type: m.document.mime_type.startsWith('video') ? 'video' : 'image', file_id: m.document.file_id };
    if (!item) continue;
    const base = { chat_id: m.chat.id, message_id: m.message_id, caption: m.caption || '' };
    if (m.media_group_id) {
      const g = byGroup.get(m.media_group_id) || { chat_id: m.chat.id, message_id: m.message_id, media_group: m.media_group_id, items: [], caption: '' };
      g.items.push(item);
      if (m.caption) g.caption = m.caption;
      g.message_id = Math.min(g.message_id, m.message_id);
      byGroup.set(m.media_group_id, g);
    } else {
      singles.push({ ...base, media_group: 'single-' + m.message_id, items: [item] });
    }
  }
  return [...byGroup.values(), ...singles];
}

function createBot(token, deps) {
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
  return {
    async getUpdates(offset) {
      const r = await deps.httpPostJson(api('getUpdates'), { offset, timeout: 25, allowed_updates: ['message'] }, 30000);
      const j = JSON.parse(r.body || '{}');
      return j.result || [];
    },
    async getFileUrl(fileId) {
      const r = await deps.httpPostJson(api('getFile'), { file_id: fileId });
      const j = JSON.parse(r.body || '{}');
      if (!j.ok) throw new Error('getFile 失败: ' + r.body);
      return `https://api.telegram.org/file/bot${token}/${j.result.file_path}`;
    },
    async sendMessage(chatId, text) {
      return deps.httpPostJson(api('sendMessage'), { chat_id: chatId, text });
    },
    async sendVideo(chatId, fileUrlOrPath, caption) {
      // Phase 1：成品有公开 URL 时用 URL 发；否则回退发下载链接文本（见 worker）。
      return deps.httpPostJson(api('sendVideo'), { chat_id: chatId, video: fileUrlOrPath, caption: caption || '' });
    },
  };
}

module.exports = { groupUpdates, createBot };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/telegram.test.js`
Expected: `TG_OK`

- [ ] **Step 5: 提交**

```bash
git add lib/telegram.js test/telegram.test.js
git commit -m "feat(telegram): 相册聚合(media_group)+ bot 收发封装"
```

---

### Task 8: HTTP 服务 server.js（剪辑页 + 提交 + 轮询装配）

**Files:**
- Create: `server.js`
- Modify: `index.html`（预加载 + 提交，见 Task 9）
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `createDb`、`sign/verify`、`readJsonBody/sendJson`、`groupUpdates/createBot`、`parseCaption`。
- Produces（HTTP）:
  - `GET /edit?job=<id>&sign=<sig>` → 返回 index.html（前端自己再拉 /api/job）
  - `GET /api/job?job=<id>&sign=<sig>` → `{id, media:[{type,url}], title, description, tags}`（url = `/media/<id>/<file>`）
  - `GET /media/<id>/<file>` → 媒体文件（限定在 WORK_DIR/<id> 内，防目录穿越）
  - `POST /api/submit` `{job, sign, edit_spec}` → 校验签名 + job 处于 editing → 存 edit_spec、status=rendering → `{ok:true}`

- [ ] **Step 1: 写失败测试**

```js
// test/server.test.js
process.env.SIGN_SECRET = 'sec';
process.env.WORK_DIR = require('os').tmpdir() + '/jj-srv-' + Date.now();
process.env.DB_PATH = process.env.WORK_DIR + '/jobs.sqlite';
process.env.PORT = '34320';
process.env.TELEGRAM_BOT_TOKEN = ''; // 不启轮询
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { app, db } = require('../server'); // server.js 导出 {app(http.Server), db}
const { sign } = require('../lib/sign');

function get(path) { return new Promise((res)=>{ http.get('http://127.0.0.1:34320'+path, r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));}); }); }
function post(path, obj){ return new Promise((res)=>{ const b=Buffer.from(JSON.stringify(obj)); const r=http.request('http://127.0.0.1:34320'+path,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':b.length}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d}));}); r.end(b); }); }

(async () => {
  fs.mkdirSync(process.env.WORK_DIR + '/1', { recursive: true });
  fs.writeFileSync(process.env.WORK_DIR + '/1/a.jpg', 'x');
  const job = db.create({ tg_chat_id: 'c', media: [{ type: 'image', path: process.env.WORK_DIR + '/1/a.jpg' }], title: 'T', description: 'D', tags: ['k'], mode: 'manual', status: 'editing' });
  const s = sign(job.id);

  // 签名错 → 403
  assert.strictEqual((await get(`/api/job?job=${job.id}&sign=bad`)).status, 403);
  // 正确 → 拿到 media url + 元数据
  const okr = await get(`/api/job?job=${job.id}&sign=${s}`);
  assert.strictEqual(okr.status, 200);
  const jj = JSON.parse(okr.body);
  assert.strictEqual(jj.title, 'T');
  assert.ok(jj.media[0].url.includes('/media/' + job.id + '/'));
  // 目录穿越被挡
  assert.strictEqual((await get(`/media/${job.id}/../../etc/passwd`)).status, 400);
  // submit：签名对 + editing → rendering
  const sub = await post('/api/submit', { job: job.id, sign: s, edit_spec: { aspect: 'auto', clips: [{ index: 0, order: 0 }] } });
  assert.strictEqual(sub.status, 200);
  assert.strictEqual(db.get(job.id).status, 'rendering');
  // 重复 submit（已不是 editing）→ 409
  assert.strictEqual((await post('/api/submit', { job: job.id, sign: s, edit_spec: {} })).status, 409);

  app.close();
  console.log('SERVER_OK');
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/server.test.js`
Expected: FAIL（server.js 不存在 / 未导出 app）

- [ ] **Step 3: 实现 server.js**

```js
// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createDb } = require('./lib/db');
const { verify } = require('./lib/sign');
const { readJsonBody, sendJson } = require('./lib/util');

const PORT = parseInt(process.env.PORT || '3001', 10);
const WORK_DIR = process.env.WORK_DIR || (require('os').tmpdir() + '/jianji');
const DB_PATH = process.env.DB_PATH || path.join(WORK_DIR, 'jobs.sqlite');
const db = createDb(DB_PATH);

function safeMediaPath(id, file) {
  const base = path.resolve(WORK_DIR, String(id));
  const target = path.resolve(base, file);
  if (target !== base && !target.startsWith(base + path.sep)) return null; // 防穿越
  return target;
}

const app = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/edit' || p === '/' )) {
      const html = await fs.promises.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/api/job') {
      const id = u.searchParams.get('job'), sig = u.searchParams.get('sign');
      if (!verify(id, sig)) return sendJson(res, 403, { error: '签名无效' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, {
        id: job.id, title: job.title, description: job.description, tags: job.tags || [],
        media: (job.media || []).map((m) => ({ type: m.type, url: `/media/${job.id}/${path.basename(m.path)}` })),
      });
    }

    if (req.method === 'GET' && p.startsWith('/media/')) {
      const [, , id, ...rest] = p.split('/');
      const file = decodeURIComponent(rest.join('/'));
      const fp = safeMediaPath(id, file);
      if (!fp) return sendJson(res, 400, { error: '非法路径' });
      try { const buf = await fs.promises.readFile(fp); res.writeHead(200); return res.end(buf); }
      catch { return sendJson(res, 404, { error: '文件不存在' }); }
    }

    if (req.method === 'POST' && p === '/api/submit') {
      const { job: id, sign: sig, edit_spec } = await readJsonBody(req);
      if (!verify(id, sig)) return sendJson(res, 403, { error: '签名无效' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      if (job.status !== 'editing') return sendJson(res, 409, { error: '任务不可提交（状态=' + job.status + '）' });
      if (!edit_spec || typeof edit_spec !== 'object') return sendJson(res, 400, { error: 'edit_spec 缺失' });
      db.update(id, { edit_spec, status: 'rendering' });
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { error: '服务器错误' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log('jianji 服务已启动 http://localhost:' + PORT));
  // Telegram 轮询 + worker 在 Task 10 装配（require 后启动）
  try { require('./worker').startWorker({ db, workDir: WORK_DIR }); } catch {}
  try { require('./telegram-poll').startPolling({ db, workDir: WORK_DIR }); } catch {}
} else {
  app.listen(PORT);
}

module.exports = { app, db };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/server.test.js`
Expected: `SERVER_OK`

- [ ] **Step 5: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat(server): 剪辑页 + /api/job + /media(防穿越) + /api/submit(签名+状态门)"
```

---

### Task 9: 前端改造 index.html（预加载 + 提交 spec）

**Files:**
- Modify: `index.html`（在末尾 `</script>` 前追加一段对接逻辑；不动现有剪辑 UI）

**Interfaces:**
- Consumes: `GET /api/job`、`POST /api/submit`；复用现有全局 `clips`、`smartEdit`、`$('aspectSel'/'segLenSel'/'fadeSel')`、`exportBtn`。
- Produces: 从 URL `?job=&sign=` 预加载媒体为 clips；把「导出」改造成提交 edit_spec。

- [ ] **Step 1: 手动验证脚手架（无自动测试，属 UI）**

先确认现有导出按钮 id 与 clips 结构（Task 前置阅读）：`exportBtn`、`clips[].{start,end,type}`、`aspectSel/segLenSel/fadeSel`。

- [ ] **Step 2: 追加对接逻辑到 index.html（`</script>` 前）**

```html
<script>
// ---------- Telegram 任务对接 ----------
(async function initFromJob() {
  const q = new URLSearchParams(location.search);
  const job = q.get('job'), sign = q.get('sign');
  if (!job || !sign) return; // 直接访问：保持原纯前端行为
  try {
    const r = await fetch(`/api/job?job=${encodeURIComponent(job)}&sign=${encodeURIComponent(sign)}`);
    if (!r.ok) throw new Error('任务加载失败');
    const data = await r.json();
    // 预加载媒体为 File（fetch blob → File），复用现有 addFiles
    const files = [];
    for (const m of data.media) {
      const b = await (await fetch(m.url)).blob();
      const name = m.url.split('/').pop();
      files.push(new File([b], name, { type: b.type || (m.type === 'image' ? 'image/jpeg' : 'video/mp4') }));
    }
    if (typeof addFiles === 'function') await addFiles(files);
    else if (typeof handleFiles === 'function') await handleFiles(files); // 兼容函数名
    // 「导出合成视频」改成提交
    const btn = document.getElementById('exportBtn');
    if (btn) {
      btn.textContent = '⬇ 生成并发回 Telegram';
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '提交中…';
        const edit_spec = {
          aspect: document.getElementById('aspectSel').value,
          segLen: parseFloat(document.getElementById('segLenSel').value),
          fade: parseFloat(document.getElementById('fadeSel').value),
          clips: clips.map((c, i) => ({ index: i, start: c.start, end: c.end, order: i, type: c.type })),
        };
        const sub = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job, sign, edit_spec }) });
        const jr = await sub.json();
        if (sub.ok && jr.ok) { btn.textContent = '✓ 已提交，渲染完自动发群'; alert('已提交，渲染完成会自动发回 Telegram，可关闭本页'); }
        else { btn.disabled = false; btn.textContent = '⬇ 生成并发回 Telegram'; alert(jr.error || '提交失败'); }
      };
    }
  } catch (e) { alert(e.message); }
})();
</script>
```

> 注：实现时先在 index.html 找到现有"添加文件"的函数真名（可能是 `addFiles`/`handleFiles`/`onFiles`），把上面兼容分支收敛成实际那个。

- [ ] **Step 3: 手动验证**

本地起 server（`PORT=3001 SIGN_SECRET=x WORK_DIR=/tmp/jj node server.js`），造一个 editing 任务 + 放两个媒体文件，用签名 URL 打开 `/edit?job=1&sign=...`，确认：媒体自动加载进时间线、「生成」按钮变文案、点击后 job 转 rendering。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat(frontend): 从任务预加载媒体 + 导出改为提交 edit_spec(带 job/sign)"
```

---

### Task 10: 后台 worker.js + Telegram 轮询 telegram-poll.js（集成，真实素材/真实 bot）

**Files:**
- Create: `worker.js`
- Create: `telegram-poll.js`
- Create: `lib/ffprobe.js`（`ffprobeDuration` + `readFrames` 供 smartcut/render 用真实 ffmpeg）

**Interfaces:**
- `worker.startWorker({db, workDir}) -> void`：`setInterval` 每 3s `claimNext('rendering','rendering')`… 实际用一个「加锁」状态 `rendering`→内部处理→`done/failed`。为避免重复领取，用中间态：`claimNext('rendering','processing')` → 渲染 → done。
- `telegram-poll.startPolling({db, workDir}) -> void`：循环 getUpdates → groupUpdates → 每个相册批次下载媒体、parseCaption、db.create(status: EDIT_MODE==='auto' ? 'rendering'(附默认spec) : 'editing') → manual 发剪辑链接；auto 不发。
- `ffprobeDuration(path)->Promise<number>`；`readFrames(path,n)->Promise<Buffer[]>`（`ffmpeg -vf select 均匀取 n 帧 -s 48x27 -pix_fmt gray -f rawvideo pipe:1` 切成 n 段）。

- [ ] **Step 1: 集成 ffprobe/抽帧 lib/ffprobe.js**

```js
// lib/ffprobe.js
const { run } = require('./util');
const { spawn } = require('child_process');

async function ffprobeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', file], 30000);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}
// 均匀抽 n 帧、48x27 灰度 raw；每帧 48*27=1296 字节
function readFrames(file, n) {
  return new Promise((resolve, reject) => {
    const W=48,H=27, frameBytes=W*H;
    const args = ['-hide_banner','-loglevel','error','-i',file,
      '-vf',`fps=${Math.max(1,Math.round(n/ Math.max(1,1)))},scale=${W}:${H}`, // 简化：后面用 select 更准
      '-frames:v',String(n),'-pix_fmt','gray','-f','rawvideo','pipe:1'];
    const ps = spawn('ffmpeg', args);
    const chunks=[]; ps.stdout.on('data',c=>chunks.push(c));
    ps.on('error',reject);
    ps.on('close',()=>{ const buf=Buffer.concat(chunks); const frames=[]; for(let i=0;i+frameBytes<=buf.length;i+=frameBytes) frames.push(buf.subarray(i,i+frameBytes)); resolve(frames); });
  });
}
module.exports = { ffprobeDuration, readFrames };
```

（说明：均匀抽帧的 `-vf fps=` 表达式在集成时按视频真实时长校准，保证抽到 ~n 帧覆盖全片；用一段真实短视频跑通后固化。）

- [ ] **Step 2: worker.js（领取 rendering → 渲染 → 回传）**

```js
// worker.js
const path = require('path');
const { render } = require('./lib/render');
const { run } = require('./lib/util');

let botRef = null; // 由 telegram-poll 注入，供回传
function setBot(bot, resultChat, publicBase) { botRef = { bot, resultChat, publicBase }; }

function startWorker({ db, workDir }) {
  const tick = async () => {
    const job = db.claimNext('rendering', 'processing');
    if (job) {
      try {
        const out = path.join(workDir, job.id, 'out.mp4');
        await render(job, out, { run, defaults: { imageDur: parseInt(process.env.DEFAULT_IMAGE_DUR||'3',10) } });
        db.update(job.id, { status: 'done', result_path: out });
        if (botRef) {
          const cap = [job.title, job.description, (job.tags||[]).map(t=>'#'+t).join(' ')].filter(Boolean).join('\n');
          // 成品公开 URL = publicBase + /media/<id>/out.mp4；超 50MB 则发下载链接文本
          const url = `${botRef.publicBase}/media/${job.id}/out.mp4`;
          const size = require('fs').statSync(out).size;
          if (size <= 50*1024*1024) await botRef.bot.sendVideo(botRef.resultChat || job.tg_chat_id, url, cap);
          else await botRef.bot.sendMessage(botRef.resultChat || job.tg_chat_id, `成品已生成（超50MB，下载）：${url}\n${cap}`);
        }
      } catch (e) {
        db.update(job.id, { status: 'failed', error: String(e.message).slice(0,300) });
        console.error('[worker] render failed', job.id, e.message);
      }
    }
    setTimeout(tick, 3000);
  };
  tick();
}
module.exports = { startWorker, setBot };
```

- [ ] **Step 3: telegram-poll.js（收相册 → 下载 → 建任务 → 发链接）**

```js
// telegram-poll.js
const fs = require('fs');
const path = require('path');
const { httpGet, httpPostJson } = require('./lib/util');
const { groupUpdates, createBot } = require('./lib/telegram');
const { parseCaption } = require('./lib/caption');
const { sign } = require('./lib/sign');
const { ffprobeDuration } = require('./lib/ffprobe');
const { smartSegmentForVideo, pickSegment } = require('./lib/smartcut');
const { readFrames } = require('./lib/ffprobe');
const { setBot } = require('./worker');

async function startPolling({ db, workDir }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.warn('TELEGRAM_BOT_TOKEN 未配置，不启轮询'); return; }
  const bot = createBot(token, { httpGet, httpPostJson });
  const mode = (process.env.EDIT_MODE || 'manual');
  const publicBase = (process.env.EDIT_URL || `http://localhost:${process.env.PORT||3001}`).replace(/\/+$/,'');
  setBot(bot, process.env.TG_RESULT_CHAT, publicBase);

  let offset = 0;
  const loop = async () => {
    try {
      const updates = await bot.getUpdates(offset);
      for (const u of updates) offset = Math.max(offset, u.update_id + 1);
      for (const batch of groupUpdates(updates)) {
        const dir = path.join(workDir, 'incoming-' + batch.media_group);
        fs.mkdirSync(dir, { recursive: true });
        const media = [];
        for (let i = 0; i < batch.items.length; i++) {
          const it = batch.items[i];
          const url = await bot.getFileUrl(it.file_id);
          const ext = it.type === 'image' ? 'jpg' : 'mp4';
          const fp = path.join(dir, `m${i}.${ext}`);
          const g = await httpGet(url, 120000);
          fs.writeFileSync(fp, g.buffer);
          media.push({ type: it.type, path: fp, tg_file_id: it.file_id });
        }
        const meta = parseCaption(batch.caption);
        // 首个视频尺寸(auto 比例用)
        let probe_w, probe_h;
        const firstVid = media.find(m => m.type === 'video');
        if (firstVid) { try { const s = await ffprobeSize(firstVid.path); probe_w=s.w; probe_h=s.h; } catch {} }
        const base = { tg_chat_id: batch.chat_id, tg_message_id: batch.message_id, media_group: batch.media_group,
          media, title: meta.title, description: meta.description, tags: meta.tags, mode, probe_w, probe_h };
        if (mode === 'auto') {
          const spec = await buildDefaultSpec(media);
          const job = db.create({ ...base, edit_spec: spec, status: 'rendering' });
          console.log('[poll] auto job', job.id);
        } else {
          const job = db.create({ ...base, status: 'editing' });
          const link = `${publicBase}/edit?job=${job.id}&sign=${sign(job.id)}`;
          await bot.sendMessage(batch.chat_id, `收到素材，点这里剪辑：\n${link}`);
          console.log('[poll] manual job', job.id, link);
        }
      }
    } catch (e) { console.error('[poll] error', e.message); }
    setTimeout(loop, 1000);
  };
  loop();
}

// 默认 spec：图片 order 靠前当片头，视频各自智能选段
async function buildDefaultSpec(media) {
  const segLen = parseInt(process.env.DEFAULT_SEG_LEN||'5',10);
  const clips = [];
  let order = 0;
  for (let i = 0; i < media.length; i++) {
    if (media[i].type === 'image') { clips.push({ index: i, order: order++, type: 'image' }); }
  }
  for (let i = 0; i < media.length; i++) {
    if (media[i].type === 'video') {
      const seg = await smartSegmentForVideo(media[i].path, segLen, { ffprobeDuration, readFrames });
      clips.push({ index: i, start: seg.start, end: seg.end, order: order++, type: 'video' });
    }
  }
  return { aspect: process.env.DEFAULT_ASPECT || 'auto', segLen, fade: parseFloat(process.env.DEFAULT_FADE||'0.35'), clips };
}

async function ffprobeSize(file) {
  const { run } = require('./lib/util');
  const { stdout } = await run('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0:s=x', file], 30000);
  const m = /(\d+)x(\d+)/.exec(stdout.trim()); return m ? { w:+m[1], h:+m[2] } : { w:720, h:1280 };
}

module.exports = { startPolling };
```

- [ ] **Step 3b: 集成验证（真实素材,手动）**

1. 造两个本地文件（1 图 1 短视频），手工 db.create 一个 rendering 任务（带默认 spec），启动 worker，确认生成 `out.mp4` 且能播放（`ffprobe out.mp4` 有时长）。
2. 若成片无声/段对不齐：在 `lib/render.js` 补音频 map + `acrossfade`，重跑直到成片正常。这一步的产出物 = 一条能播的 mp4。

- [ ] **Step 4: 端到端（真实 bot,手动）**

用真实 `TELEGRAM_BOT_TOKEN` + 测试群，发一个相册（1视频+1图+caption），确认：bot 回剪辑链接 → 打开剪辑 → 提交 → worker 渲染 → 成品视频发回群。

- [ ] **Step 5: 提交**

```bash
git add worker.js telegram-poll.js lib/ffprobe.js
git commit -m "feat(worker+poll): 后台渲染回传 + Telegram 相册收料建任务(manual/auto)"
```

---

### Task 11: 部署 deploy.sh（对齐 fengmiantu 安全）

**Files:**
- Create: `deploy.sh`

- [ ] **Step 1: 写 deploy.sh**

```bash
#!/usr/bin/env bash
# jianji 剪辑服务一键部署（Ubuntu）。 sudo bash deploy.sh
set -euo pipefail
APP_DIR=/opt/jianji; ENV_FILE=/etc/jianji.env; SVC_USER=jianji; PORT=3001
REPO=https://github.com/a0916w/jianji.git
[ "$(id -u)" -eq 0 ] || { echo "用 root 跑"; exit 1; }
apt-get update -y && apt-get install -y ffmpeg nodejs npm git python3 make g++
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
( cd "$APP_DIR" && npm install --omit=dev )   # better-sqlite3(预编译二进制,无则本地编译)
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR/work"
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
EDIT_MODE=manual
PORT=3001
EDIT_URL=http://18.163.100.253:3001
SIGN_SECRET=改成一段随机字符串
TELEGRAM_BOT_TOKEN=BotFather给的token
TG_RESULT_CHAT=
WORK_DIR=/opt/jianji/work
DB_PATH=/opt/jianji/work/jobs.sqlite
DEFAULT_IMAGE_DUR=3
DEFAULT_SEG_LEN=5
DEFAULT_FADE=0.35
DEFAULT_ASPECT=auto
EOF
  chmod 600 "$ENV_FILE"; echo ">>> 生成 $ENV_FILE，填好 SIGN_SECRET/TELEGRAM_BOT_TOKEN 后重跑"; exit 0
fi
chmod 600 "$ENV_FILE"
cat > /etc/systemd/system/jianji.service <<EOF
[Unit]
Description=jianji edit service
After=network.target
[Service]
User=$SVC_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
EnvironmentFile=$ENV_FILE
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now jianji
sleep 1; systemctl --no-pager status jianji | head -5
echo "OK: http://<IP>:$PORT （安全组放行 $PORT；出站放行 FTP/Telegram 无关，需能访问 api.telegram.org）"
```

- [ ] **Step 2: 提交**

```bash
git add deploy.sh
git commit -m "chore(deploy): 一键部署(600 env + systemd 非 root),对齐 fengmiantu"
```

---

## Self-Review

**Spec coverage:**
- 输入相册+A格式caption → Task 7(聚合)+Task 2(解析)+Task 10(下载建任务) ✓
- media_group 配对 → Task 7 groupUpdates ✓
- SQLite/DB jobs → Task 4（better-sqlite3,jobs 表字段对齐 spec；JSON 字段存 TEXT 列）✓
- manual 流程(链接/预加载/提交/渲染/回传) → Task 8/9/10 ✓
- auto 流程 → Task 10 buildDefaultSpec + mode 分支 ✓
- ffmpeg 复刻 jianji(图3s/视频选5s/0.35fade/aspect) → Task 5+6+10 ✓
- 安全(签名/非root/env) → Task 3 + Task 11；SSRF 白名单 Phase 1 无外呼(只呼 Telegram 官方域)，故不需 fengmiantu 那条白名单，spec 第七节的 SSRF 主要针对回调，此服务无回调，已收窄 ✓
- 8 env → Task 11 env 模板齐 ✓

**Placeholder scan:** 无 TBD/TODO 式占位；两处"实现时校准"(抽帧 fps 表达式、音频 acrossfade)是明确的集成期修正步骤且写明产出物，非空泛占位。

**Type consistency:** `edit_spec.clips[].{index,start,end,order,type}` 在 render(Task6)/前端(Task9)/默认spec(Task10)一致；`media[].{type,path,tg_file_id}` 一致；`db` 接口(create/get/update/claimNext)跨 Task 一致；`bot`(getUpdates/getFileUrl/sendMessage/sendVideo) Task7 定义、Task10 使用一致。

**偏差记录（供 spec 复核）:** Phase 1 无 SSRF 白名单（无对外回调，只呼 Telegram 官方 API），符合 spec 意图。DB 按 spec 用 SQLite(better-sqlite3,一个 npm 依赖)。
