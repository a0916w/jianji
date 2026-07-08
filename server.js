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
