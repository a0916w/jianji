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
      const badge = (s) => {
        const c = s === 'done' ? 'var(--green)'
          : s === 'failed' ? 'var(--red)'
          : (s === 'rendering' || s === 'processing') ? 'var(--accent)'
          : s === 'editing' ? 'var(--accent-2)'
          : 'var(--text-dim)';
        return `<span class="badge" style="--c:${c}">${escapeHtml(s)}</span>`;
      };
      const rows = jobs.map((j) => {
        const editUrl = `/edit?job=${encodeURIComponent(j.id)}&sign=${sign(j.id)}`;
        const dl = j.status === 'done'
          ? `<a class="btn btn-dl" href="/media/${encodeURIComponent(j.id)}/out.mp4?sign=${sign(j.id)}">下载</a>`
          : '';
        const title = j.title ? escapeHtml(j.title) : '<span class="dim">—</span>';
        return `<tr>
          <td class="mono">${escapeHtml(j.id)}</td>
          <td>${badge(j.status)}</td>
          <td class="dim">${escapeHtml(j.mode)}</td>
          <td><span class="src">${escapeHtml(j.source)}</span></td>
          <td class="title">${title}</td>
          <td class="dim mono">${escapeHtml(j.created_at)}</td>
          <td><div class="actions"><a class="btn btn-edit" href="${editUrl}">剪辑</a>${dl}</div></td>
        </tr>`;
      }).join('\n');
      const count = jobs.length;
      const body = count ? `<div class="card"><table>
      <thead><tr><th>编号</th><th>状态</th><th>模式</th><th>来源</th><th>标题</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
        : `<div class="card"><div class="empty">还没有任务 🎬<br><span class="dim">Telegram 群发相册,或直接开网页上传后点「生成到服务器」</span></div></div>`;
      const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>任务列表 · 智能剪辑</title>
<style>
  :root{--bg:#0f1115;--panel:#181c23;--panel-2:#1f2530;--border:#2a3140;--text:#e8ecf3;--text-dim:#8b94a7;--accent:#4f7cff;--accent-2:#7c5cff;--green:#2ecc8f;--red:#ff5c6c;--radius:12px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;padding:24px}
  .wrap{max-width:1180px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px}
  .logo{display:flex;align-items:center;gap:8px;text-decoration:none;font-size:22px;font-weight:700;letter-spacing:.5px;transition:opacity .15s}
  .logo:hover{opacity:.82}
  .logo .bolt{color:var(--accent)}
  .logo .grad{background:linear-gradient(90deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .meta{font-size:13px;color:var(--text-dim);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .page{font-weight:600;color:var(--text);padding:3px 10px;border:1px solid var(--border);border-radius:20px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;box-shadow:0 0 8px var(--green);animation:pulse 2s infinite;margin-right:6px}
  @keyframes pulse{50%{opacity:.35}}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;overflow-x:auto}
  table{border-collapse:collapse;width:100%;min-width:640px}
  th{background:var(--panel-2);color:var(--text-dim);font-size:12px;font-weight:600;letter-spacing:.5px;text-align:left;padding:12px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:11px 14px;font-size:14px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tbody tr{transition:background .15s}
  tbody tr:hover{background:var(--panel-2)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
  .dim{color:var(--text-dim)}
  .title{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{display:inline-block;padding:3px 11px;border-radius:20px;font-size:12px;font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent);border:1px solid color-mix(in srgb,var(--c) 38%,transparent)}
  .src{font-size:12px;padding:2px 9px;border-radius:6px;background:var(--panel-2);border:1px solid var(--border);color:var(--text-dim)}
  .actions{display:flex;gap:8px}
  .btn{display:inline-block;padding:6px 14px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;transition:opacity .15s,transform .1s}
  .btn:hover{opacity:.88;transform:translateY(-1px)}
  .btn-edit{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff}
  .btn-dl{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green);border:1px solid color-mix(in srgb,var(--green) 42%,transparent)}
  .empty{padding:64px 20px;text-align:center;font-size:16px;line-height:1.9}
  @media(max-width:640px){body{padding:14px}.title{max-width:140px}}
</style></head>
<body><div class="wrap">
  <header>
    <a class="logo" href="/" title="返回首页"><span class="bolt">⚡</span><span class="grad">快速智能剪辑</span></a>
    <div class="meta"><span class="page">任务列表</span><span><span class="dot"></span>每 5 秒自动刷新</span><span>共 ${count} 个</span></div>
  </header>
  ${body}
</div></body></html>`;
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
