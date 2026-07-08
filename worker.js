// worker.js —— 后台渲染 worker：领取 rendering→processing→渲染→done/failed，成品经签名 URL 回传 Telegram。
const fs = require('fs');
const path = require('path');
const { render } = require('./lib/render');
const { run } = require('./lib/util');
const { sign } = require('./lib/sign');
const { ffprobeHasAudio } = require('./lib/ffprobe');

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
              try { m.hasAudio = await ffprobeHasAudio(m.path); }
              catch (probeErr) {
                console.error('[worker] ffprobeHasAudio 探测失败，按有音轨处理', m.path, (probeErr && probeErr.message) || probeErr);
                m.hasAudio = true;
              }
            }
          }
          await render(job, out, { run, defaults: { imageDur: parseInt(process.env.DEFAULT_IMAGE_DUR || '3', 10) } });
          db.update(job.id, { status: 'done', result_path: out });
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

// 成品发回 Telegram：MUST-FIX #2 — /media URL 必须带签名，否则 server 会 403。
async function deliverResult(job, outPath) {
  // 网页来源的任务没有 Telegram 会话可回传（tg_chat_id 也不存在）——成品留在磁盘/DB，
  // 由用户从 /jobs 管理列表的「下载」链接取，调用方（tick）无论如何都会把状态标 done。
  if (job.source === 'web' || !job.tg_chat_id) return;
  if (!botRef) return; // 未注入 bot（如单测直接调 render）时跳过回传
  const cap = [job.title, job.description, (job.tags || []).map((t) => '#' + t).join(' ')].filter(Boolean).join('\n');
  const url = `${botRef.publicBase}/media/${job.id}/out.mp4?sign=${sign(job.id)}`;
  const chatId = botRef.resultChat || job.tg_chat_id;
  try {
    const size = fs.statSync(outPath).size;
    if (size <= 50 * 1024 * 1024) {
      await botRef.bot.sendVideo(chatId, url, cap);
    } else {
      await botRef.bot.sendMessage(chatId, `成品已生成（超50MB，下载）：${url}\n${cap}`);
    }
  } catch (e) {
    // 发送失败不回滚任务状态（渲染已成功，成品仍在磁盘/DB 里）
    console.error('[worker] 回传结果失败', job.id, (e && e.message) || e);
  }
}

module.exports = { startWorker, setBot };
