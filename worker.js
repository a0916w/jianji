// worker.js —— 后台渲染 worker：领取 rendering→processing→渲染→done/failed，成品经签名 URL 回传 Telegram。
const fs = require('fs');
const path = require('path');
const { render } = require('./lib/render');
const { run } = require('./lib/util');
const { sign } = require('./lib/sign');

let botRef = null; // 由 telegram-poll 注入，供成片回传
function setBot(bot, resultChat, publicBase) { botRef = { bot, resultChat, publicBase }; }

function startWorker({ db, workDir }) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    const job = db.claimNext('rendering', 'processing');
    if (job) {
      try {
        const outDir = path.join(workDir, job.id);
        fs.mkdirSync(outDir, { recursive: true });
        const out = path.join(outDir, 'out.mp4');
        await render(job, out, { run, defaults: { imageDur: parseInt(process.env.DEFAULT_IMAGE_DUR || '3', 10) } });
        db.update(job.id, { status: 'done', result_path: out });
        await deliverResult(job, out);
      } catch (e) {
        try { db.update(job.id, { status: 'failed', error: String((e && e.message) || e).slice(0, 300) }); } catch {}
        console.error('[worker] render failed', job.id, (e && e.message) || e);
      }
    }
    if (!stopped) timer = setTimeout(tick, 3000);
  };

  tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

// 成品发回 Telegram：MUST-FIX #2 — /media URL 必须带签名，否则 server 会 403。
async function deliverResult(job, outPath) {
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
