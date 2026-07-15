// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDb } = require('./lib/db');
const { sign, verify } = require('./lib/sign');
const { readJsonBody, sendJson } = require('./lib/util');
const { ffprobeDuration } = require('./lib/ffprobe');
const mingshun = require('./lib/mingshun');

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
const WEB_UPLOAD_EXT = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.mov': 'video' };
const WEB_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB（原 200MB 太小，大视频源常见几百 MB~1GB+）

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
      const allJobs = db.listAll();
      // 筛选：标题(q) / 状态(status) / 创建日期(date, YYYY-MM-DD 前缀匹配)。
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      const fstatus = u.searchParams.get('status') || '';
      const fdate = (u.searchParams.get('date') || '').trim();
      const filtered = allJobs.filter((j) => {
        if (q && !String(j.title || '').toLowerCase().includes(q)) return false;
        if (fstatus && j.status !== fstatus) return false;
        if (fdate && !String(j.created_at || '').startsWith(fdate)) return false;
        return true;
      });
      // 分页：50/页。
      const PER = 50;
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / PER));
      let page = parseInt(u.searchParams.get('page') || '1', 10);
      if (!Number.isFinite(page) || page < 1) page = 1;
      if (page > pages) page = pages;
      const jobs = filtered.slice((page - 1) * PER, page * PER);
      const sliceCfg = mingshun.sliceInfo(); // { enabled, themes }
      // 明顺返回的错误体里中文是 \uXXXX 转义的（如「视频标题重复」），解成可读中文再展示。
      const decodeU = (s) => String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const jobDetails = {};
      for (const j of jobs) {
        jobDetails[j.id] = {
          title: j.title || '', description: j.description || '', tags: j.tags || [],
          status: j.status, mode: j.mode, source: j.source, created_at: j.created_at,
          dl: j.status === 'done' ? `/media/${encodeURIComponent(j.id)}/out.mp4?sign=${sign(j.id)}` : null,
          slice_status: j.slice_status || '', slice_theme: j.slice_theme || '', slice_video_id: j.slice_video_id || '', slice_error: decodeU(j.slice_error || ''),
        };
      }
      const jobDetailsJson = JSON.stringify(jobDetails).replace(/</g, '\\u003c');
      // 成片时长展示（秒）。老任务未存 duration 时后台异步补探测（每次翻页最多补几条，
      // 避免一次性 spawn 太多 ffprobe），下次刷新即显示。
      const fmtDur = (d) => (typeof d === 'number' && d > 0)
        ? (d >= 60
            ? `${Math.floor(d / 60)}分${String(Math.round(d % 60)).padStart(2, '0')}秒`
            : `${Math.round(d)}秒`)
        : '<span class="dim">—</span>';
      let backfilled = 0;
      for (const j of jobs) {
        if (j.status === 'done' && j.result_path && (j.duration == null) && backfilled < 8) {
          backfilled++;
          ffprobeDuration(j.result_path)
            .then((d) => { if (d > 0) db.update(j.id, { duration: d }); })
            .catch(() => {}); // 补探测失败静默，下次再试
        }
      }
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
        const play = j.status === 'done'
          ? `<button class="btn btn-play" data-play="${escapeHtml(j.id)}">播放</button>`
          : '';
        const dl = j.status === 'done'
          ? `<a class="btn btn-dl" href="/media/${encodeURIComponent(j.id)}/out.mp4?sign=${sign(j.id)}" download="out-${encodeURIComponent(j.id)}.mp4">下载</a>`
          : '';
        // 切片按钮：仅在明顺切片可用且任务已完成时出现；已切过则显示状态而非按钮。
        let slice = '';
        if (sliceCfg.enabled && j.status === 'done') {
          if (j.slice_status === 'done') slice = `<span class="badge" style="--c:var(--green)" title="video_id=${escapeHtml(j.slice_video_id || '')}">已切片</span>`;
          else if (j.slice_status === 'slicing') slice = `<span class="badge" style="--c:var(--accent)">切片中</span>`;
          else if (j.slice_status === 'failed') slice = `<span class="badge" style="--c:var(--red);cursor:help" title="${escapeHtml(decodeU(j.slice_error) || '未知错误')}">切片失败</span><button class="btn btn-slice" data-slice="${escapeHtml(j.id)}" title="${escapeHtml(decodeU(j.slice_error))}">重试</button>`;
          else slice = `<button class="btn btn-slice" data-slice="${escapeHtml(j.id)}">切片</button>`;
        }
        const title = j.title ? escapeHtml(j.title) : '<span class="dim">—</span>';
        return `<tr>
          <td class="mono">${escapeHtml(j.id)}</td>
          <td>${badge(j.status)}</td>
          <td class="dim mono">${fmtDur(j.duration)}</td>
          <td class="title" data-title-id="${escapeHtml(j.id)}" data-title="${escapeHtml(j.title || '')}" title="点击修改标题">${title}</td>
          <td class="dim mono">${escapeHtml(j.created_at)}</td>
          <td><div class="actions"><a class="btn btn-edit" href="${editUrl}">剪辑</a><button class="btn btn-info" data-id="${escapeHtml(j.id)}">详情</button>${play}${dl}${slice}<button class="btn btn-del" data-id="${escapeHtml(j.id)}">删除</button></div></td>
        </tr>`;
      }).join('\n');
      const count = total;
      const hasFilter = !!(q || fstatus || fdate);
      const STATUSES = ['editing', 'downloading', 'processing', 'rendering', 'done', 'failed'];
      const statusOpts = ['<option value="">全部状态</option>']
        .concat(STATUSES.map((s) => `<option value="${s}"${fstatus === s ? ' selected' : ''}>${s}</option>`)).join('');
      const filterForm = `<form method="get" action="/jobs" class="filters">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="text" name="q" value="${escapeHtml(u.searchParams.get('q') || '')}" placeholder="搜索标题">
        <select name="status">${statusOpts}</select>
        <input type="date" name="date" value="${escapeHtml(fdate)}">
        <button type="submit" class="btn btn-primary">筛选</button>
        <a class="btn btn-info" href="/jobs?token=${encodeURIComponent(token)}">重置</a>
      </form>`;
      const mkPageUrl = (pp) => {
        const sp = new URLSearchParams({ token });
        if (q) sp.set('q', u.searchParams.get('q'));
        if (fstatus) sp.set('status', fstatus);
        if (fdate) sp.set('date', fdate);
        sp.set('page', String(pp));
        return '/jobs?' + sp.toString();
      };
      const pager = pages > 1 ? `<div class="pager">
        ${page > 1 ? `<a class="btn btn-info" href="${mkPageUrl(page - 1)}">← 上一页</a>` : ''}
        <span class="dim">第 ${page} / ${pages} 页 · 共 ${total} 个</span>
        ${page < pages ? `<a class="btn btn-info" href="${mkPageUrl(page + 1)}">下一页 →</a>` : ''}
      </div>` : '';
      const table = count ? `<div class="card"><table>
      <thead><tr><th>编号</th><th>状态</th><th>时长</th><th>标题</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
        : `<div class="card"><div class="empty">${hasFilter ? '没有符合条件的任务' : '还没有任务 🎬'}<br><span class="dim">${hasFilter ? '换个筛选条件试试' : 'Telegram 群发相册,或直接开网页上传后点「生成到服务器」'}</span></div></div>`;
      const body = filterForm + table + pager;
      const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>任务列表 · 智能剪辑</title>
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
  .btn{display:inline-flex;align-items:center;justify-content:center;text-align:center;padding:6px 14px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;transition:opacity .15s,transform .1s}
  .filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .filters input,.filters select{padding:8px 10px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;outline:none}
  .filters input[type=text]{min-width:180px}
  .pager{display:flex;gap:14px;align-items:center;justify-content:center;margin-top:18px}
  td.title[data-title-id]{cursor:pointer}
  td.title[data-title-id]:hover{color:var(--accent)}
  .title-edit{width:100%;padding:5px 7px;background:var(--panel-2);color:var(--text);border:1px solid var(--accent);border-radius:6px;font-size:13px;font-family:inherit;outline:none}
  .btn:hover{opacity:.88;transform:translateY(-1px)}
  .btn-edit{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff}
  .btn-dl{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green);border:1px solid color-mix(in srgb,var(--green) 42%,transparent)}
  .btn-del{background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red);border:1px solid color-mix(in srgb,var(--red) 40%,transparent);cursor:pointer;font-family:inherit}
  .btn-info{background:var(--panel-2);color:var(--text);border:1px solid var(--border);cursor:pointer;font-family:inherit}
  .btn-play{background:color-mix(in srgb,var(--accent) 20%,transparent);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);cursor:pointer;font-family:inherit}
  .btn-slice{background:color-mix(in srgb,var(--accent-2) 20%,transparent);color:var(--accent-2);border:1px solid color-mix(in srgb,var(--accent-2) 45%,transparent);cursor:pointer;font-family:inherit}
  .slice-select{width:100%;padding:10px 12px;margin-top:6px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit}
  .btn-primary{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff;cursor:pointer;font-family:inherit;padding:9px 20px}
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
  .modal-video{width:100%;max-height:60vh;border-radius:8px;background:#000;display:block}
  .modal-tags{display:flex;flex-wrap:wrap;gap:6px}
  .modal-tags .src{background:var(--panel-2)}
  .modal-actions{margin-top:18px}
  @media(max-width:640px){body{padding:14px}.title{max-width:140px}}
</style></head>
<body><div class="wrap">
  <header>
    <a class="logo" href="/" title="返回首页"><span class="bolt">⚡</span><span class="grad">快速智能剪辑</span></a>
    <div class="meta"><span class="page">任务列表</span><span>共 ${count} 个</span><a class="btn btn-info" href="/report?token=${encodeURIComponent(token)}">📊 报告</a></div>
  </header>
  ${body}
</div>
<div id="modal" class="modal" hidden>
  <div class="modal-card">
    <button type="button" class="modal-close" id="modalClose" aria-label="关闭">&times;</button>
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-field">
      <div class="modal-label">标题（可修改）</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="text" id="modalTitleInput" maxlength="200" class="slice-select" style="margin-top:0;flex:1" placeholder="成片标题">
        <button type="button" class="btn btn-primary" id="modalTitleSave" style="padding:9px 16px">保存</button>
      </div>
      <div id="modalTitleMsg" style="font-size:12px;margin-top:6px;min-height:14px;color:var(--text-dim)"></div>
    </div>
    <div class="modal-field" id="modalPlayerField" hidden><div class="modal-label">在线播放</div><video id="modalVideo" class="modal-video" controls preload="metadata" playsinline></video></div>
    <div class="modal-field"><div class="modal-label">状态 / 模式 / 来源</div><div class="modal-value" id="modalMeta"></div></div>
    <div class="modal-field"><div class="modal-label">创建时间</div><div class="modal-value" id="modalCreated"></div></div>
    <div class="modal-field"><div class="modal-label">描述</div><div class="modal-value" id="modalDesc"></div></div>
    <div class="modal-field"><div class="modal-label">标签</div><div class="modal-tags" id="modalTags"></div></div>
    <div class="modal-field" id="modalSliceField" hidden><div class="modal-label">切片错误（失败原因）</div><div class="modal-value" id="modalSliceErr" style="color:var(--red)"></div></div>
    <div class="modal-actions"><a class="btn btn-dl" id="modalDl" href="#">下载成品</a></div>
  </div>
</div>
<div id="sliceModal" class="modal" hidden>
  <div class="modal-card" style="max-width:420px">
    <button type="button" class="modal-close" id="sliceClose" aria-label="关闭">&times;</button>
    <div class="modal-title">切片到明顺</div>
    <div class="modal-field">
      <div class="modal-label">选择主题</div>
      <select id="sliceTheme" class="slice-select"></select>
    </div>
    <div class="modal-field" id="sliceMsg" style="min-height:16px;font-size:13px;color:var(--text-dim)"></div>
    <div class="modal-actions"><button type="button" class="btn btn-primary" id="sliceGo">开始切片</button></div>
  </div>
</div>
<script>
  const JOB_DETAILS = ${jobDetailsJson};
  const SLICE = ${JSON.stringify({ enabled: sliceCfg.enabled, themes: sliceCfg.themes })};
  const TOKEN = new URLSearchParams(location.search).get('token');

  // 列表行内联改标题：点标题格 → 变输入框 → Enter/失焦保存, Esc 取消。
  document.addEventListener('click', (e) => {
    const cell = e.target.closest('td.title[data-title-id]');
    if (!cell || cell.querySelector('input')) return;
    const id = cell.dataset.titleId;
    const cur = cell.dataset.title || '';
    const input = document.createElement('input');
    input.type = 'text'; input.value = cur; input.maxLength = 200; input.className = 'title-edit';
    cell.textContent = '';
    cell.appendChild(input);
    input.focus(); input.select();
    let settled = false;
    const restore = (text) => { cell.textContent = text || '—'; };
    const cancel = () => { if (settled) return; settled = true; restore(cur); };
    const save = async () => {
      if (settled) return; settled = true;
      const title = input.value.trim();
      if (title === cur) { restore(cur); return; }
      restore('保存中…');
      try {
        const r = await fetch('/api/job-update-title?token=' + encodeURIComponent(TOKEN), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, title }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
        cell.dataset.title = title;
        restore(title);
        if (JOB_DETAILS[id]) JOB_DETAILS[id].title = title;
      } catch (err) {
        restore(cur);
        alert('保存失败: ' + (err.message || err));
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', save);
  });

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
  const modalVideo = document.getElementById('modalVideo');
  const modalPlayerField = document.getElementById('modalPlayerField');
  const modalTitleInput = document.getElementById('modalTitleInput');
  const modalTitleSave = document.getElementById('modalTitleSave');
  const modalTitleMsg = document.getElementById('modalTitleMsg');
  let modalId = null;

  function openModal(id) {
    const d = JOB_DETAILS[id];
    if (!d) return;
    modalId = id;
    modalTitle.textContent = d.title || '（无标题）';
    modalTitleInput.value = d.title || '';
    modalTitleMsg.textContent = '';
    modalTitleMsg.style.color = 'var(--text-dim)';
    modalTitleSave.disabled = false;
    modalMeta.textContent = (d.status || '—') + ' / ' + (d.mode || '—') + ' / ' + (d.source || '—');
    // 切片失败时显示错误原因，让操作员看清为什么，别盲目重试。
    const sliceField = document.getElementById('modalSliceField');
    if (d.slice_status === 'failed' && d.slice_error) {
      document.getElementById('modalSliceErr').textContent = d.slice_error;
      sliceField.hidden = false;
    } else {
      sliceField.hidden = true;
    }
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
      if (modalVideo.getAttribute('src') !== d.dl) modalVideo.src = d.dl;
      modalPlayerField.hidden = false;
    } else {
      modalDl.hidden = true;
      modalPlayerField.hidden = true;
      modalVideo.pause();
      modalVideo.removeAttribute('src');
      modalVideo.load();
    }
    modal.hidden = false;
  }
  function closeModal() {
    modal.hidden = true;
    modalVideo.pause();
  }

  // 详情里改标题：保存到任务，并就地更新弹窗标题 + 列表标题单元格。
  modalTitleSave.addEventListener('click', async () => {
    if (!modalId) return;
    const title = modalTitleInput.value.trim();
    modalTitleSave.disabled = true;
    modalTitleMsg.style.color = 'var(--text-dim)';
    modalTitleMsg.textContent = '保存中…';
    try {
      const r = await fetch('/api/job-update-title?token=' + encodeURIComponent(TOKEN), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: modalId, title }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || '保存失败');
      if (JOB_DETAILS[modalId]) JOB_DETAILS[modalId].title = title;
      modalTitle.textContent = title || '（无标题）';
      const cell = document.querySelector('.btn-info[data-id="' + (window.CSS && CSS.escape ? CSS.escape(modalId) : modalId) + '"]');
      const td = cell && cell.closest('tr') && cell.closest('tr').querySelector('td.title');
      if (td) td.textContent = title || '';
      modalTitleMsg.style.color = 'var(--green)';
      modalTitleMsg.textContent = '✅ 已保存';
    } catch (err) {
      modalTitleMsg.style.color = 'var(--red)';
      modalTitleMsg.textContent = '❌ ' + (err.message || err);
    } finally {
      modalTitleSave.disabled = false;
    }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-info');
    if (btn) { openModal(btn.dataset.id); return; }
    const playBtn = e.target.closest('.btn-play');
    if (playBtn) { openModal(playBtn.dataset.play); return; }
    if (e.target.id === 'modalClose') { closeModal(); return; }
    if (e.target === modal) { closeModal(); return; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // ---- 切片弹窗 ----
  const sliceModal = document.getElementById('sliceModal');
  const sliceTheme = document.getElementById('sliceTheme');
  const sliceMsg = document.getElementById('sliceMsg');
  const sliceGo = document.getElementById('sliceGo');
  let sliceId = null;
  (SLICE.themes || []).forEach((t) => {
    const o = document.createElement('option'); o.value = t; o.textContent = t; sliceTheme.appendChild(o);
  });
  function openSlice(id) {
    sliceId = id;
    sliceGo.disabled = false; sliceGo.textContent = '开始切片';
    // 上次切片失败的话，把错误原因显示出来——让操作员先看清为什么失败，别盲目重试。
    const d = JOB_DETAILS[id];
    if (d && d.slice_status === 'failed' && d.slice_error) {
      sliceMsg.style.color = 'var(--red)';
      sliceMsg.textContent = '上次切片失败：' + d.slice_error;
    } else {
      sliceMsg.textContent = ''; sliceMsg.style.color = 'var(--text-dim)';
    }
    // 记住上次选的主题：有存过且仍是可选项就默认选它。
    try {
      const last = localStorage.getItem('jianji_last_slice_theme');
      if (last && [...sliceTheme.options].some((o) => o.value === last)) sliceTheme.value = last;
    } catch (_) {}
    sliceModal.hidden = false;
  }
  function closeSlice() { sliceModal.hidden = true; sliceId = null; }
  document.addEventListener('click', (e) => {
    const sb = e.target.closest('.btn-slice');
    if (sb) { openSlice(sb.dataset.slice); return; }
    if (e.target.id === 'sliceClose' || e.target === sliceModal) { closeSlice(); return; }
  });
  sliceGo.addEventListener('click', async () => {
    if (!sliceId) return;
    try { localStorage.setItem('jianji_last_slice_theme', sliceTheme.value); } catch (_) {}
    sliceGo.disabled = true; sliceGo.textContent = '切片中…';
    sliceMsg.style.color = 'var(--text-dim)'; sliceMsg.textContent = '正在上传成片到明顺并触发切片，请稍候…';
    try {
      const r = await fetch('/api/slice?token=' + encodeURIComponent(TOKEN), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sliceId, theme: sliceTheme.value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || '切片失败');
      sliceMsg.style.color = 'var(--green)';
      sliceMsg.textContent = '✅ 已提交明顺切片' + (d.video_id != null ? '（video_id=' + d.video_id + '）' : '');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      sliceMsg.style.color = 'var(--red)';
      sliceMsg.textContent = '❌ ' + (err.message || err);
      sliceGo.disabled = false; sliceGo.textContent = '重试';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sliceModal.hidden) closeSlice();
  });
</script>
</body></html>`;
      // no-referrer：页面地址可能带 ?sign=/?token=，避免点击链接或加载资源时经 Referer 泄漏。
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
    }

    // 报告页：一天处理多少 / 提交切片多少 / 按分类(切片主题)分。
    if (req.method === 'GET' && p === '/report') {
      const token = u.searchParams.get('token');
      if (!verifyAdminToken(token)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden');
      }
      const jobs = db.listAll();
      const dayOf = (iso) => (String(iso || '').slice(0, 10) || '未知');
      const days = new Map();      // 日期 -> { total, submitted, sliced, failed }
      const dayThemes = new Map(); // 日期||主题 -> { date, theme, submitted, sliced, failed }
      for (const j of jobs) {
        const d = dayOf(j.created_at);
        if (!days.has(d)) days.set(d, { total: 0, submitted: 0, sliced: 0, failed: 0 });
        const day = days.get(d);
        day.total++;
        const submitted = !!(j.slice_theme && String(j.slice_theme).length); // 提交过切片 = 选了主题
        if (submitted) {
          day.submitted++;
          const th = String(j.slice_theme);
          const key = d + '||' + th;
          if (!dayThemes.has(key)) dayThemes.set(key, { date: d, theme: th, submitted: 0, sliced: 0, failed: 0 });
          const t = dayThemes.get(key);
          t.submitted++;
          if (j.slice_status === 'done') { day.sliced++; t.sliced++; }
          else if (j.slice_status === 'failed') { day.failed++; t.failed++; }
        }
      }
      const dayRows = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30)
        .map(([d, s]) => `<tr><td class="mono">${escapeHtml(d)}</td><td>${s.total}</td><td>${s.submitted}</td><td style="color:var(--green)">${s.sliced}</td><td style="color:var(--red)">${s.failed}</td></tr>`).join('');
      const themeRows = [...dayThemes.values()]
        .sort((a, b) => b.date.localeCompare(a.date) || a.theme.localeCompare(b.theme))
        .slice(0, 300)
        .map((x) => `<tr><td class="mono">${escapeHtml(x.date)}</td><td>${escapeHtml(x.theme)}</td><td>${x.submitted}</td><td style="color:var(--green)">${x.sliced}</td><td style="color:var(--red)">${x.failed}</td></tr>`).join('');
      const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>报告 · 智能剪辑</title>
<style>
  :root{--bg:#0f1115;--panel:#181c23;--panel-2:#1f2530;--border:#2a3140;--text:#e8ecf3;--text-dim:#8b94a7;--accent:#4f7cff;--green:#2ecc8f;--red:#ff5c6c;--radius:12px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;padding:24px}
  .wrap{max-width:900px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:8px}
  .logo{display:flex;align-items:center;gap:8px;text-decoration:none;font-size:20px;font-weight:700;color:var(--text)}
  a.back{font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--border);padding:6px 12px;border-radius:8px}
  h2.sec{font-size:15px;margin:22px 0 10px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow-x:auto}
  table{border-collapse:collapse;width:100%;min-width:420px}
  th{background:var(--panel-2);color:var(--text-dim);font-size:12px;font-weight:600;text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:10px 14px;font-size:14px;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .empty{padding:40px;text-align:center;color:var(--text-dim)}
</style></head>
<body><div class="wrap">
  <header>
    <a class="logo" href="/"><span style="color:var(--accent)">⚡</span> 剪辑报告</a>
    <a class="back" href="/jobs?token=${encodeURIComponent(token)}">← 任务列表</a>
  </header>
  <h2 class="sec">按天汇总（近 30 天，按创建日期）</h2>
  <div class="card">${dayRows ? `<table><thead><tr><th>日期</th><th>处理数</th><th>提交切片</th><th>切片完成</th><th>切片失败</th></tr></thead><tbody>${dayRows}</tbody></table>` : '<div class="empty">暂无数据</div>'}</div>
  <h2 class="sec">按分类（切片主题）汇总 · 按天</h2>
  <div class="card">${themeRows ? `<table><thead><tr><th>日期</th><th>主题</th><th>提交切片</th><th>完成</th><th>失败</th></tr></thead><tbody>${themeRows}</tbody></table>` : '<div class="empty">暂无切片记录</div>'}</div>
</div></body></html>`;
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
      const EXT_CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
      const ext = require('path').extname(fp).toLowerCase();
      const ct = EXT_CT[ext];
      if (!ct) return sendJson(res, 415, { error: '不支持的文件类型' });
      // HEAD 支持是防御性的：Telegram 拉公开 URL 前会先发 HEAD 探测内容类型，之前只处理 GET
      // 会 404（text/plain）被判定成"网页"而拒发。回传成品已改走 multipart 直传（见
      // worker.js deliverResult），这里仍保留 HEAD 支持，覆盖 >50MB 分支的下载链接等场景。
      const baseName = require('path').basename(fp);
      const mediaHeaders = {
        'Content-Type': ct,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline; filename="' + baseName + '"',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer', // 防带 ?sign= 的媒体地址经 Referer 泄漏
        'Accept-Ranges': 'bytes',
      };
      if (req.method === 'HEAD') {
        try {
          const st = fs.statSync(fp);
          res.writeHead(200, { ...mediaHeaders, 'Content-Length': st.size });
          return res.end();
        }
        catch { return sendJson(res, 404, { error: '文件不存在' }); }
      }
      try {
        const st = fs.statSync(fp);
        const total = st.size;
        // 支持 HTTP Range：HTML5 <video> 在线播放 / 拖动进度依赖 206 分块，
        // 尤其 Safari/iOS 不发或不认全量响应时会整段拒播。同时改为流式，避免整片读进内存。
        const range = req.headers.range;
        const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m && (m[1] || m[2])) {
          let start = m[1] === '' ? NaN : parseInt(m[1], 10);
          let end = m[2] === '' ? NaN : parseInt(m[2], 10);
          if (Number.isNaN(start)) { start = Math.max(0, total - end); end = total - 1; } // bytes=-N 后缀
          if (Number.isNaN(end)) end = total - 1;
          if (start > end || start < 0 || end >= total) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total, 'Accept-Ranges': 'bytes' });
            return res.end();
          }
          res.writeHead(206, { ...mediaHeaders, 'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Content-Length': end - start + 1 });
          return fs.createReadStream(fp, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...mediaHeaders, 'Content-Length': total });
        return fs.createReadStream(fp).pipe(res);
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

    if (req.method === 'POST' && p === '/api/job-update-title') {
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
      if (!db.get(id)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
        return res.end(JSON.stringify({ error: '任务不存在' }));
      }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
      db.update(id, { title });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      return res.end(JSON.stringify({ ok: true, title }));
    }

    if (req.method === 'POST' && p === '/api/submit') {
      const { job: id, sign: sig, edit_spec, slice_theme } = await readJsonBody(req);
      if (!verify(id, sig)) return sendJson(res, 403, { error: '签名无效' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      // 只拒绝“正在飞行中”的任务（已在下载/处理/渲染），editing/done/failed 都放行——
      // 后者对应重新剪辑已完成或失败的任务（从 /jobs 列表点「剪辑」进来）。
      const INFLIGHT_STATUSES = ['downloading', 'processing', 'rendering'];
      if (INFLIGHT_STATUSES.includes(job.status)) return sendJson(res, 409, { error: '任务不可提交（状态=' + job.status + '）' });
      if (!edit_spec || typeof edit_spec !== 'object') return sendJson(res, 400, { error: 'edit_spec 缺失' });
      const patch = { edit_spec, status: 'rendering' };
      // 提交时选了切片主题：渲染完成后 worker 会自动发明顺切片（见 worker.js maybeSlice）。
      // 校验主题合法且切片可用，否则忽略（不因切片配置问题挡住正常渲染）。
      const theme = typeof slice_theme === 'string' ? slice_theme.trim() : '';
      const mc = mingshun.cfg();
      if (theme && mc.enabled && mingshun.configured(mc) && (!mc.themes.length || mc.themes.includes(theme))) {
        patch.slice_theme = theme;
        patch.slice_status = 'pending';
      }
      db.update(id, patch);
      return sendJson(res, 200, { ok: true });
    }

    // 前端拉切片配置：是否可用 + 可选主题列表（不含密钥）。/jobs 与 /edit 页都用它填主题下拉。
    if (req.method === 'GET' && p === '/api/slice-info') {
      return sendJson(res, 200, mingshun.sliceInfo());
    }

    // 立即切片：把已完成任务的成片发明顺切片。鉴权 = 管理 token 或该任务的 sign（覆盖 /jobs 按钮与 /edit 页两种入口）。
    if (req.method === 'POST' && p === '/api/slice') {
      const body = await readJsonBody(req);
      const id = body.id;
      const token = u.searchParams.get('token') || body.token;
      const sig = u.searchParams.get('sign') || body.sign;
      const authed = verifyAdminToken(token) || (typeof id === 'string' && !!id && verify(id, sig));
      if (!authed) return sendJson(res, 403, { error: '未授权' });
      if (typeof id !== 'string' || !id) return sendJson(res, 400, { error: 'id 缺失' });
      const job = db.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      if (job.status !== 'done') return sendJson(res, 409, { error: '任务未完成，无法切片（状态=' + job.status + '）' });
      const mc = mingshun.cfg();
      if (!mc.enabled || !mingshun.configured(mc)) return sendJson(res, 400, { error: '明顺切片未配置/未启用' });
      const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
      if (mc.themes.length && theme && !mc.themes.includes(theme)) return sendJson(res, 400, { error: '非法主题' });
      const base = path.resolve(WORK_DIR);
      const dir = path.resolve(WORK_DIR, String(id));
      if (dir === base || !dir.startsWith(base + path.sep) || path.dirname(dir) !== base) return sendJson(res, 400, { error: '非法路径' });
      const outPath = path.join(dir, 'out.mp4');
      if (!fs.existsSync(outPath)) return sendJson(res, 404, { error: '成片文件不存在' });
      try {
        db.update(id, { slice_status: 'slicing', slice_theme: theme, slice_error: null });
        const r = await mingshun.sliceVideo(outPath, { title: job.title || '', description: job.description || '', theme });
        db.update(id, { slice_status: 'done', slice_video_id: r.video_id != null ? String(r.video_id) : null });
        return sendJson(res, 200, { ok: true, video_id: r.video_id });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 300);
        try { db.update(id, { slice_status: 'failed', slice_error: msg }); } catch (_) {}
        return sendJson(res, 500, { error: '切片失败: ' + msg });
      }
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
