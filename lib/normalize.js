// lib/normalize.js —— 把非 H.264 的视频（常见 HEVC/H.265）就地重编码成 H.264。
// 目的：①浏览器 <video> 播不了 H.265，编辑器加载不出片段（剪辑页空白）②渲染时省去
// HEVC 解码、更轻更稳。素材进来(Telegram/web)和 worker 渲染前都调它兜底。
const fs = require('fs');
const { run } = require('./util');

// 取第一条视频流的编码名；无视频流/探测失败 → null。
async function videoCodec(file, exec = run) {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1', file,
    ], 30000);
    return String(stdout || '').trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 确保 file 是 H.264。已是 h264 / 非视频 / 探测不到编码 → 不动，返回 false。
 * 否则就地重编码替换（保持原路径与文件名，media[].path 不变），成功返回 true。
 * 转码失败会抛出，由调用方决定吞掉(ingest 尽力而为)还是上抛(worker 计入渲染失败)。
 * deps 可注入 { run, videoCodec, timeoutMs } 供测试。
 */
async function ensureH264(file, deps = {}) {
  const exec = deps.run || run;
  const probe = deps.videoCodec || videoCodec;

  const codec = await probe(file, exec);
  if (!codec || codec === 'h264') return false;

  const tmp = file + '.h264.mp4';
  try {
    await exec('ffmpeg', [
      '-y', '-i', file,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-ar', '44100', '-b:a', '128k',
      '-movflags', '+faststart', tmp,
    ], deps.timeoutMs || 600000);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { ensureH264, videoCodec };
