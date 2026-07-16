// worker.js —— 后台渲染 worker：领取 rendering→processing→渲染→done/failed，成品经签名 URL 回传 Telegram。
const fs = require('fs');
const path = require('path');
const { render } = require('./lib/render');
const { run } = require('./lib/util');
const { sign } = require('./lib/sign');
const { ffprobeHasAudio, ffprobeDuration } = require('./lib/ffprobe');
const { ensureH264 } = require('./lib/normalize');
const mingshun = require('./lib/mingshun');

let botRef = null; // 由 telegram-poll 注入，供成片回传
function setBot(bot, resultChat, publicBase) { botRef = { bot, resultChat, publicBase }; }

function startWorker({ db, workDir }) {
  let stopped = false;
  let timer = null;

  // I1：进程崩溃/被杀可能把任务卡在 processing（已领取但没来得及渲染完/更新状态），
  // 启动时把这些孤儿任务退回 rendering，交由正常 tick 循环重新领取重试。
  try {
    const orphaned = db.listByStatus('processing');
    if (orphaned.length) {
      orphaned.forEach((j) => db.update(j.id, { status: 'rendering' }));
      console.log(`[worker] 启动时重排 ${orphaned.length} 个孤儿 processing 任务 → rendering`);
    } else {
      console.log('[worker] 启动时无孤儿 processing 任务');
    }
  } catch (e) {
    console.error('[worker] 孤儿任务重排失败', (e && e.message) || e);
  }

  // M1：claim + 渲染整体包一层 try/catch，任何抛出都被吞掉记录日志，
  // 保证 finally 里的重新调度一定执行，循环不会因为一次异常永久停摆。
  const tick = async () => {
    if (stopped) return;
    try {
      const job = db.claimNext('rendering', 'processing');
      if (job) {
        try {
          const outDir = path.join(workDir, job.id);
          fs.mkdirSync(outDir, { recursive: true });
          const out = path.join(outDir, 'out.mp4');
          // I2：视频片段可能没有音轨（手机/录屏常见），先探测再决定 render.js
          // 是给它接自身 [i:a] 还是用静音轨兜底，避免 ffmpeg 因引用不存在的
          // 音轨而整任务失败。
          for (const m of job.media || []) {
            if (m && m.type === 'video') {
              // 渲染前兜底：非 H.264(如 HEVC)就地转码。省去 HEVC 解码、也让重试的旧任务能过；
              // 尽力而为——转码失败不直接判死，仍让 render 用原文件试(ffmpeg 能解 HEVC)。
              try { await ensureH264(m.path); }
              catch (nErr) {
                console.error('[worker] H.264 归一化失败(继续用原文件)', m.path, (nErr && nErr.message) || nErr);
              }
              try { m.hasAudio = await ffprobeHasAudio(m.path); }
              catch (probeErr) {
                console.error('[worker] ffprobeHasAudio 探测失败，按有音轨处理', m.path, (probeErr && probeErr.message) || probeErr);
                m.hasAudio = true;
              }
            }
          }
          await render(job, out, { run, defaults: { imageDur: parseInt(process.env.DEFAULT_IMAGE_DUR || '3', 10) } });
          let outDur = null;
          try { outDur = await ffprobeDuration(out); }
          catch (durErr) { console.error('[worker] ffprobeDuration 失败', job.id, (durErr && durErr.message) || durErr); }
          db.update(job.id, { status: 'done', result_path: out, duration: outDur });
          await maybeSlice(db, job.id, out);
          await deliverResult(job, out);
        } catch (e) {
          try { db.update(job.id, { status: 'failed', error: String((e && e.message) || e).slice(0, 300) }); } catch {}
          console.error('[worker] render failed', job.id, (e && e.message) || e);
        }
      }
    } catch (e) {
      console.error('[worker] tick 异常（已捕获，循环继续）', (e && e.message) || e);
    } finally {
      if (!stopped) timer = setTimeout(tick, 3000);
    }
  };

  tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

// 若任务在提交时选了切片主题（slice_theme），渲染完成后把成片发明顺切片。
// 失败不影响成品本身（状态已 done），只把 slice_status/slice_error 记到 DB。
async function maybeSlice(db, id, outPath) {
  let job;
  try { job = db.get(id); } catch (_) { return; }
  if (!job || !job.slice_theme) return;
  if (!mingshun.cfg().enabled) return;
  try {
    db.update(id, { slice_status: 'slicing', slice_error: null });
    const r = await mingshun.sliceVideo(outPath, { title: job.title || '', description: job.description || '', theme: job.slice_theme });
    db.update(id, { slice_status: 'done', slice_video_id: r.video_id != null ? String(r.video_id) : null });
    console.log('[worker] 切片成功', id, '主题=', job.slice_theme, 'video_id=', r.video_id);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    try { db.update(id, { slice_status: 'failed', slice_error: msg }); } catch (_) {}
    console.error('[worker] 切片失败', id, msg);
  }
}

// 成品发回 Telegram：MUST-FIX #2 — /media URL 必须带签名，否则 server 会 403。
async function deliverResult(job, outPath) {
  // 网页来源的任务没有 Telegram 会话可回传（tg_chat_id 也不存在）——成品留在磁盘/DB，
  // 由用户从 /jobs 管理列表的「下载」链接取，调用方（tick）无论如何都会把状态标 done。
  if (job.source === 'web' || !job.tg_chat_id) return;
  if (!botRef) return; // 未注入 bot（如单测直接调 render）时跳过回传
  const dlUrl = `${botRef.publicBase}/media/${job.id}/out.mp4?sign=${sign(job.id)}`;
  const editUrl = `${botRef.publicBase}/edit?job=${job.id}&sign=${sign(job.id)}`;
  // 说明 = 标题/描述/#标签 + 下载成品链接 + 重新剪辑链接（Telegram 会把纯文本 URL 自动变可点）。
  const cap = [
    job.title,
    job.description,
    (job.tags || []).map((t) => '#' + t).join(' '),
    '⬇ 下载成品: ' + dlUrl,
    '✂️ 重新剪辑: ' + editUrl,
  ].filter(Boolean).join('\n');
  const chatId = botRef.resultChat || job.tg_chat_id;
  try {
    const size = fs.statSync(outPath).size;
    if (size <= 50 * 1024 * 1024) {
      // 直传字节而非发 URL：Telegram 拉 URL 前会先发 HEAD，/media 路由曾经只支持 GET 会 404，
      // Telegram 判定为"非视频网页内容"而拒发（已用一次真实 multipart 直传验证可行）。
      await botRef.bot.sendVideoFile(chatId, outPath, cap);
    } else {
      await botRef.bot.sendMessage(chatId, `成品已生成（超50MB，无法直接发视频）:\n${cap}`);
    }
  } catch (e) {
    // 发送失败不回滚任务状态（渲染已成功，成品仍在磁盘/DB 里）
    console.error('[worker] 回传结果失败', job.id, (e && e.message) || e);
  }
}

module.exports = { startWorker, setBot };
