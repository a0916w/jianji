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

    // 当前剪辑模式（供页面顶部显示：人工剪辑 / 自动剪辑）。
    if (req.method === 'GET' && p === '/api/mode') {
      return sendJson(res, 200, { mode: (process.env.EDIT_MODE || 'manual') });
    }

    if (req.method === 'GET' && p === '/jobs') {
      const token = u.searchParams.get('token');
      if (!verifyAdminToken(token)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden');
      }
      const jobs = db.listAll();
      const jobDetails = {};
      for (const j of jobs) {
        jobDetails[j.id] = {
          title: j.title || '', description: j.description || '', tags: j.tags || [],
          status: j.status, mode: j.mode, source: j.source, created_at: j.created_at,
          dl: j.status === 'done' ? `/media/${encodeURIComponent(j.id)}/out.mp4?sign=${sign(j.id)}` : null,
        };
      }
      const jobDetailsJson = JSON.stringify(jobDetails).replace(/</g, '\\u003c');
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
          ? `<a class="btn btn-dl" href="/media/${encodeURIComponent(j.id)}/out.mp4?sign=${sign(j.id)}" download="out-${encodeURIComponent(j.id)}.mp4">下载</a>`
          : '';
        const title = j.title ? escapeHtml(j.title) : '<span class="dim">—</span>';
        return `<tr>
          <td class="mono">${escapeHtml(j.id)}</td>
          <td>${badge(j.status)}</td>
          <td class="dim">${escapeHtml(j.mode)}</td>
          <td><span class="src">${escapeHtml(j.source)}</span></td>
          <td class="title">${title}</td>
          <td class="dim mono">${escapeHtml(j.created_at)}</td>
          <td><div class="actions"><a class="btn btn-edit" href="${editUrl}">剪辑</a><button class="btn btn-info" data-id="${escapeHtml(j.id)}">详情</button>${dl}<button class="btn btn-del" data-id="${escapeHtml(j.id)}">删除</button></div></td>
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
  .btn-del{background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red);border:1px solid color-mix(in srgb,var(--red) 40%,transparent);cursor:pointer;font-family:inherit}
  .btn-info{background:var(--panel-2);color:var(--text);border:1px solid var(--border);cursor:pointer;font-family:inherit}
  .empty{padding:64px 20px;text-align:center;font-size:16px;line-height:1.9}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
  .modal[hidden]{display:none}
  .modal-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);max-width:560px;width:100%;max-height:80vh;overflow-y:auto;padding:22px 24px;position:relative}
  .modal-close{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--text-dim);font-size:22px;line-height:1;cursor:pointer;font-family:inherit}
  .modal-close:hover{color:var(--text)}
  .modal-title{font-size:18px;font-weight:700;margin-bottom:16px;padding-right:28px;word-break:break-word}
  .modal-field{margin-bottom:14px}
  .modal-label{font-size:12px;color:var(--text-dim);font-weight:600;letter-spacing:.5px;margin-bottom:4px}
  .modal-value{font-size:14px;white-space:pre-wrap;word-break:break-word}
  .modal-tags{display:flex;flex-wrap:wrap;gap:6px}
  .modal-tags .src{background:var(--panel-2)}
  .modal-actions{margin-top:18px}
  @media(max-width:640px){body{padding:14px}.title{max-width:140px}}
</style></head>
<body><div class="wrap">
  <header>
    <a class="logo" href="/" title="返回首页"><span class="bolt">⚡</span><span class="grad">快速智能剪辑</span></a>
    <div class="meta"><span class="page">任务列表</span><span><span class="dot"></span>每 5 秒自动刷新</span><span>共 ${count} 个</span></div>
  </header>
  ${body}
</div>
<div id="modal" class="modal" hidden>
  <div class="modal-card">
    <button type="button" class="modal-close" id="modalClose" aria-label="关闭">&times;</button>
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-field"><div class="modal-label">状态 / 模式 / 来源</div><div class="modal-value" id="modalMeta"></div></div>
    <div class="modal-field"><div class="modal-label">创建时间</div><div class="modal-value" id="modalCreated"></div></div>
    <div class="modal-field"><div class="modal-label">描述</div><div class="modal-value" id="modalDesc"></div></div>
    <div class="modal-field"><div class="modal-label">标签</div><div class="modal-tags" id="modalTags"></div></div>
    <div class="modal-actions"><a class="btn btn-dl" id="modalDl" href="#">下载成品</a></div>
  </div>
</div>
<script>
  const JOB_DETAILS = ${jobDetailsJson};
  const TOKEN = new URLSearchParams(location.search).get('token');
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-del');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!confirm('确认删除任务 #' + id + '?（会一并删除该任务的文件，不可恢复）')) return;
    fetch('/api/job-delete?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then((res) => { if (res.ok) location.reload(); else alert('删除失败'); });
  });

  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalMeta = document.getElementById('modalMeta');
  const modalCreated = document.getElementById('modalCreated');
  const modalDesc = document.getElementById('modalDesc');
  const modalTags = document.getElementById('modalTags');
  const modalDl = document.getElementById('modalDl');

  function openModal(id) {
    const d = JOB_DETAILS[id];
    if (!d) return;
    modalTitle.textContent = d.title || '（无标题）';
    modalMeta.textContent = (d.status || '—') + ' / ' + (d.mode || '—') + ' / ' + (d.source || '—');
    modalCreated.textContent = d.created_at || '—';
    modalDesc.textContent = d.description || '（无描述）';
    modalTags.replaceChildren();
    (d.tags || []).forEach((t) => {
      const span = document.createElement('span');
      span.className = 'src';
      span.textContent = t;
      modalTags.appendChild(span);
    });
    if (d.dl) {
      modalDl.href = d.dl;
      modalDl.setAttribute('download', 'out-' + id + '.mp4');
      modalDl.hidden = false;
    } else {
      modalDl.hidden = true;
    }
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-info');
    if (btn) { openModal(btn.dataset.id); return; }
    if (e.target.id === 'modalClose') { closeModal(); return; }
    if (e.target === modal) { closeModal(); return; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
</script>
</body></html>`;
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
        status: job.status, source: job.source,
        result: job.status === 'done' ? `/media/${encodeURIComponent(job.id)}/out.mp4?sign=${sign(job.id)}` : null,
        media: (job.media || []).map((m) => ({ type: m.type, url: `/media/${job.id}/${path.basename(m.path)}?sign=${sig}` })),
      });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/')) {
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
      // HEAD 支持是防御性的：Telegram 拉公开 URL 前会先发 HEAD 探测内容类型，之前只处理 GET
      // 会 404（text/plain）被判定成"网页"而拒发。回传成品已改走 multipart 直传（见
      // worker.js deliverResult），这里仍保留 HEAD 支持，覆盖 >50MB 分支的下载链接等场景。
      if (req.method === 'HEAD') {
        try {
          const st = fs.statSync(fp);
          res.writeHead(200, {
            'Content-Type': ct,
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'inline; filename="' + require('path').basename(fp) + '"',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Referrer-Policy': 'no-referrer',
            'Content-Length': st.size,
          });
          return res.end();
        }
        catch { return sendJson(res, 404, { error: '文件不存在' }); }
      }
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

    if (req.method === 'POST' && p === '/api/job-delete') {
      const body = await readJsonBody(req);
      const token = u.searchParams.get('token') || body.token;
      if (!verifyAdminToken(token)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end(JSON.stringify({ error: 'forbidden' }));
      }
      const id = body.id;
      if (typeof id !== 'string' || !id) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end(JSON.stringify({ error: 'id 缺失' }));
      }
      const job = db.get(id);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end(JSON.stringify({ error: '任务不存在' }));
      }
      // 仅当解析路径确实是 WORK_DIR 的直接子目录（等同 safeMediaPath 的防穿越校验）才允许删文件
      const base = path.resolve(WORK_DIR);
      const dir = path.resolve(WORK_DIR, String(id));
      if (dir === base || !dir.startsWith(base + path.sep) || path.dirname(dir) !== base) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end(JSON.stringify({ error: '非法路径' }));
      }
      fs.rmSync(dir, { recursive: true, force: true });
      db.remove(id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(JSON.stringify({ ok: true }));
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
