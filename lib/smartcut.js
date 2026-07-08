// lib/smartcut.js —— 复刻 jianji：抽帧算相邻帧像素差(运动量),滑窗选最大 segLen 区间。
function pickSegment(scores, times, segLen, duration) {
  let bestStart = 0, bestScore = -1;
  for (let i = 0; i < times.length; i++) {
    const winStart = times[i];
    if (winStart + segLen > duration) break;
    let sum = 0;
    for (let j = i; j < times.length && times[j] <= winStart + segLen; j++) sum += scores[j];
    if (sum > bestScore) { bestScore = sum; bestStart = winStart; } // 平局取靠前窗口，与 jianji 原版一致
  }
  return { start: bestStart, end: Math.min(duration, bestStart + segLen) };
}

// 抽帧算差：用 ffmpeg 均匀抽 n 张缩略图到内存(pipe)难,改抽到临时目录再逐张比。
// deps.run = util.run; deps.readFrames(videoPath,n) -> Promise<Buffer[]>(灰度小图字节)
async function smartSegmentForVideo(videoPath, segLen, deps) {
  const duration = await deps.ffprobeDuration(videoPath);
  if (!duration || duration <= segLen + 0.3) return { start: 0, end: duration || segLen };
  const n = Math.min(30, Math.max(10, Math.floor(duration * 2)));
  const frames = await deps.readFrames(videoPath, n); // Buffer[]，等间隔 n 帧的原始灰度像素
  const times = [], scores = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i], b = frames[i - 1];
    let diff = 0;
    const len = Math.min(a.length, b.length);
    for (let p = 0; p < len; p += 8) diff += Math.abs(a[p] - b[p]);
    scores.push(diff);
    times.push(duration * i / (n - 1));
  }
  return pickSegment(scores, times, segLen, duration);
}

module.exports = { pickSegment, smartSegmentForVideo };
