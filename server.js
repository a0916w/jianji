// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDb } = require('./lib/db');
const { sign, verify } = require('./lib/sign');
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

// /jobs 管理列表的鉴权：与 lib/sign.js 的 verify() 同样用定长比较，防时序攻击；
// ADMIN_TOKEN 未配置时一律拒绝（不能因为漏配就等于不鉴权）。
function verifyAdminToken(token) {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 网页上传允许的扩展名 → media 类型
const WEB_UPLOAD_EXT = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video' };
const WEB_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

const app = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/edit' || p === '/' )) {
      const html = await fs.promises.readFile(path.join(__dirname, 'index.html'));
      // no-referrer：页面地址可能带 ?sign=/?token=，避免点击链接或加载资源时经 Referer 泄漏。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/jobs') {
      const token = u.searchParams.get('token');
      if (!verifyAdminToken(token)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden');
      }
      const jobs = db.listAll();
      const rows = jobs.map((j) => {
        const editUrl = `/edit?job=${encodeURIComponent(j.id)}&sign=${sign(j.id)}`;
        const dl = j.status === 'done'
          ? ` | <a href="/media/${encodeURIComponent(j.id)}/out.mp4?sign=${sign(j.id)}">下载</a>`
          : '';
        return `<tr><td>${escapeHtml(j.id)}</td><td>${escapeHtml(j.status)}</td><td>${escapeHtml(j.mode)}</td>` +
          `<td>${escapeHtml(j.source)}</td><td>${escapeHtml(j.title)}</td><td>${escapeHtml(j.created_at)}</td>` +
          `<td><a href="${editUrl}">剪辑</a>${dl}</td></tr>`;
      }).join('\n');
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>任务列表</title>
<style>body{font-family:sans-serif;margin:16px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:4px 8px;font-size:14px;text-align:left}</style></head>
<body><h1>任务列表</h1><table><thead><tr><th>编号</th><th>状态</th><th>模式</th><th>来源</th><th>标题</th><th>创建</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
      // no-referrer：页面地址可能带 ?sign=/?token=，避免点击链接或加载资源时经 Referer 泄漏。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
    }

    if (req.method === 'POST' && p === '/api/web-job') {
      const body = await readJsonBody(req);
      const job = db.create({
        source: 'web', mode: 'manual', status: 'editing', media: [],
        title: body.title || '', description: body.description || '', tags: body.tags || [],
      });
      return sendJson(res, 200, { ok: true, id: job.id, sign: sign(job.id) });
    }

    if (req.method === 'POST' && p === '/api/web-upload') {
      const id = u.searchParams.get('job'), sig = u.searchParams.get('sign'), rawName = u.searchParams.get('name') || '';
      if (!verify(id, sig)) return sendJson(res, 403, { error: '签名无效' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      const safeName = path.basename(rawName);
      const ext = path.extname(safeName).toLowerCase();
      const mediaType = WEB_UPLOAD_EXT[ext];
      if (!mediaType) return sendJson(res, 400, { error: '不支持的文件类型' });
      const fp = safeMediaPath(id, safeName);
      if (!fp) return sendJson(res, 400, { error: '非法路径' });
      fs.mkdirSync(path.dirname(fp), { recursive: true });

      let responded = false;
      let size = 0;
      const ws = fs.createWriteStream(fp);
      res.on('error', () => {}); // 客户端提前断开时 res 上可能触发 error，防止未监听导致进程崩溃
      const fail = (code, obj) => {
        if (responded) return;
        responded = true;
        fs.unlink(fp, () => {}); // 清理写了一半的残留文件，失败静默即可（可能压根没写出内容）
        sendJson(res, code, obj);
        // req 和 res 共用同一条 socket：先把响应体写出去，flush 完再销毁请求连接，
        // 否则先 destroy(req) 会把 socket 一并炸掉，客户端只看到裸 TCP reset 而不是 413/500。
        res.once('finish', () => req.destroy());
      };
      req.on('data', (chunk) => {
        if (responded) return;
        size += chunk.length;
        if (size > WEB_UPLOAD_MAX_BYTES) {
          ws.destroy();
          fail(413, { error: '文件过大' });
        }
      });
      req.on('error', () => { ws.destroy(); fail(500, { error: '上传失败' }); });
      ws.on('error', () => fail(500, { error: '写入失败' }));
      ws.on('finish', () => {
        if (responded) return;
        responded = true;
        const media = (job.media || []).concat([{ type: mediaType, path: fp }]);
        db.update(id, { media });
        sendJson(res, 200, { ok: true, name: safeName });
      });
      req.pipe(ws);
      return;
    }

    if (req.method === 'GET' && p === '/api/job') {
      const id = u.searchParams.get('job'), sig = u.searchParams.get('sign');
      if (!verify(id, sig)) return sendJson(res, 403, { error: '签名无效' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, {
        id: job.id, title: job.title, description: job.description, tags: job.tags || [],
        media: (job.media || []).map((m) => ({ type: m.type, url: `/media/${job.id}/${path.basename(m.path)}?sign=${sig}` })),
      });
    }

    if (req.method === 'GET' && p.startsWith('/media/')) {
      const [, , id, ...rest] = p.split('/');
      const file = decodeURIComponent(rest.join('/'));
      const fp = safeMediaPath(id, file);
      if (!fp) return sendJson(res, 400, { error: '非法路径' });
      const mediaSign = u.searchParams.get('sign');
      if (!verify(id, mediaSign)) return sendJson(res, 403, { error: '签名无效' });
      const EXT_CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4' };
      const ext = require('path').extname(fp).toLowerCase();
      const ct = EXT_CT[ext];
      if (!ct) return sendJson(res, 415, { error: '不支持的文件类型' });
      try {
        const buf = await fs.promises.readFile(fp);
        res.writeHead(200, {
          'Content-Type': ct,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline; filename="' + require('path').basename(fp) + '"',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Referrer-Policy': 'no-referrer', // 防带 ?sign= 的媒体地址经 Referer 泄漏
        });
        return res.end(buf);
      }
      catch { return sendJson(res, 404, { error: '文件不存在' }); }
    }

    if (req.method === 'POST' && p === '/api/submit') {
      const { job: id, sign: sig, edit_spec } = await readJsonBody(req);
      if (!verify(id, sig)) return sendJson(res, 403, { error: '签名无效' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      // 只拒绝“正在飞行中”的任务（已在下载/处理/渲染），editing/done/failed 都放行——
      // 后者对应重新剪辑已完成或失败的任务（从 /jobs 列表点「剪辑」进来）。
      const INFLIGHT_STATUSES = ['downloading', 'processing', 'rendering'];
      if (INFLIGHT_STATUSES.includes(job.status)) return sendJson(res, 409, { error: '任务不可提交（状态=' + job.status + '）' });
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
