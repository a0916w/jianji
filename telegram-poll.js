// telegram-poll.js —— 轮询 Telegram getUpdates → 相册聚合 → 下载素材建任务(manual 发剪辑链接 / auto 直接建默认 spec 送渲染)。
const fs = require('fs');
const path = require('path');
const { httpGet, httpPostJson } = require('./lib/util');
const { groupUpdates, createBot } = require('./lib/telegram');
const { mergeIntoPending, takeReady } = require('./lib/album-buffer');
const { parseCaption } = require('./lib/caption');
const { sign } = require('./lib/sign');
const { ffprobeDuration, readFrames, ffprobeSize } = require('./lib/ffprobe');
const { smartSegmentForVideo } = require('./lib/smartcut');
const { setBot } = require('./worker');

// 相册防抖窗口：跨轮询累积到的相册，需自最后一次收到新素材起静默满这么久才判定"到齐"并建任务。
// 只读一次（模块加载时），供 startPolling 的常驻 pending 使用；见 pollOnce 里对"一次性调用"的说明。
const ALBUM_DEBOUNCE_MS = parseInt(process.env.ALBUM_DEBOUNCE_MS, 10) || 2500;

function createDefaultBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return createBot(token, { httpGet, httpPostJson });
}

// 单个相册批次 → 建任务。
// MUST-FIX #1：先 db.create(status:'downloading') 拿到 job.id，再把素材下载到 WORK_DIR/<job.id>/，
// 使其与 server 的 /media/<id>/<basename> 以及 worker 的 out.mp4 路径口径一致。
async function ingestBatch({ db, workDir, bot, mode, publicBase, batch }) {
  const job0 = db.create({
    tg_chat_id: batch.chat_id != null ? String(batch.chat_id) : null,
    tg_message_id: batch.message_id,
    media_group: batch.media_group,
    mode,
    status: 'downloading',
  });

  const dir = path.join(workDir, job0.id);
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
  const firstVid = media.find((m) => m.type === 'video');
  if (firstVid) {
    try {
      const s = await ffprobeSize(firstVid.path);
      probe_w = s.w; probe_h = s.h;
    } catch (e) {
      console.error('[poll] ffprobeSize 失败', job0.id, e.message || e);
    }
  }

  if (mode === 'auto') {
    const spec = await buildDefaultSpec(media);
    const job = db.update(job0.id, {
      media, title: meta.title, description: meta.description, tags: meta.tags,
      probe_w, probe_h, edit_spec: spec, status: 'rendering',
    });
    console.log('[poll] auto job', job.id);
    return job;
  }

  const job = db.update(job0.id, {
    media, title: meta.title, description: meta.description, tags: meta.tags,
    probe_w, probe_h, status: 'editing',
  });
  const link = `${publicBase}/edit?job=${job.id}&sign=${sign(job.id)}`;
  try {
    await bot.sendMessage(batch.chat_id, `收到素材，点这里剪辑：\n${link}`);
  } catch (e) {
    console.error('[poll] sendMessage 失败', job.id, e.message || e);
  }
  console.log('[poll] manual job', job.id, link);
  return job;
}

// 默认 spec：图片靠前当片头，视频各自智能选段(真实 ffprobe/抽帧)。
async function buildDefaultSpec(media) {
  const segLen = parseInt(process.env.DEFAULT_SEG_LEN || '5', 10);
  const clips = [];
  let order = 0;
  for (let i = 0; i < media.length; i++) {
    if (media[i].type === 'image') clips.push({ index: i, order: order++, type: 'image' });
  }
  for (let i = 0; i < media.length; i++) {
    if (media[i].type === 'video') {
      const seg = await smartSegmentForVideo(media[i].path, segLen, { ffprobeDuration, readFrames });
      clips.push({ index: i, start: seg.start, end: seg.end, order: order++, type: 'video' });
    }
  }
  return { aspect: process.env.DEFAULT_ASPECT || 'auto', segLen, fade: parseFloat(process.env.DEFAULT_FADE || '0.35'), clips };
}

// 一次 getUpdates + 相册跨轮询缓冲 + 分批 ingest；每批独立 try/catch，一个坏相册不会拖垮整轮(MUST-FIX #3)。
//
// pending 是调用方持有的跨轮询缓冲区（Map，见 lib/album-buffer.js）。相册常常被 Telegram 拆到多次
// getUpdates 里返回，必须靠这个 Map 在轮询之间累积，等短暂静默(防抖)后才判定"到齐"、避免一个相册
// 裂成多个任务。
//
// debounceMs 的取舍：
//   - 调用方显式传入 pending（startPolling 的常驻轮询场景）→ 用 ALBUM_DEBOUNCE_MS（默认 2500ms）。
//   - 调用方没传 pending（一次性/测试场景，例如 test/poll.test.js、test/auto.test.js 单次调用
//     pollOnce 且相册已在同一次 getUpdates 里到齐）→ 用一个临时 Map 且 debounce=0，本次就绪即建任务，
//     保持"单次调用即可拿到任务"的既有行为不被防抖打破。
async function pollOnce({ db, workDir, bot, mode, publicBase, offset, pending }) {
  const hasExternalPending = !!pending;
  const buffer = pending || new Map();
  const debounceMs = hasExternalPending ? ALBUM_DEBOUNCE_MS : 0;

  const updates = await bot.getUpdates(offset);
  let newOffset = offset;
  for (const u of updates) newOffset = Math.max(newOffset, u.update_id + 1);

  // 即使本次 updates 为空也要跑 merge+takeReady：这样一个已缓冲的相册能在后续的空轮询里，
  // 单纯因为时间流逝、静默满足防抖而落地建任务。
  mergeIntoPending(buffer, groupUpdates(updates), Date.now());
  const ready = takeReady(buffer, Date.now(), debounceMs);

  const jobs = [];
  for (const batch of ready) {
    try {
      const job = await ingestBatch({ db, workDir, bot, mode, publicBase, batch });
      if (job) jobs.push(job);
    } catch (e) {
      console.error('[poll] 批次处理失败', batch.media_group, e.message || e);
    }
  }
  return { offset: newOffset, jobs };
}

function startPolling(opts = {}) {
  const { db, workDir } = opts;
  const bot = opts.bot || createDefaultBot();
  if (!bot) { console.warn('TELEGRAM_BOT_TOKEN 未配置，不启轮询'); return { stop() {} }; }

  const mode = opts.mode || process.env.EDIT_MODE || 'manual';
  const publicBase = (opts.publicBase || process.env.EDIT_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
  setBot(bot, process.env.TG_RESULT_CHAT, publicBase);

  let offset = opts.offset || 0;
  let stopped = false;
  const intervalMs = opts.intervalMs || 1000;
  // 常驻跨轮询相册缓冲区：整个轮询循环生命周期内只有这一个 Map，相册素材才能跨多次 getUpdates 累积。
  const pending = new Map();

  const runOnce = async () => {
    try {
      const r = await pollOnce({ db, workDir, bot, mode, publicBase, offset, pending });
      offset = r.offset;
      return r;
    } catch (e) {
      // MUST-FIX #3：getUpdates 本身出错(网络/Telegram 侧)也不能崩掉轮询循环。
      console.error('[poll] error', e.message || e);
      return { offset, jobs: [] };
    }
  };

  if (opts.once) {
    return runOnce().then((r) => ({ ...r, stop() { stopped = true; } }));
  }

  const loop = async () => {
    if (stopped) return;
    await runOnce();
    if (!stopped) setTimeout(loop, intervalMs);
  };
  loop();
  return { stop() { stopped = true; } };
}

module.exports = { startPolling, pollOnce, ingestBatch, buildDefaultSpec };
