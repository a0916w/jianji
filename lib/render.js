// lib/render.js —— job.media + edit_spec → ffmpeg 参数。
function parseAspect(job, defaults) {
  const a = job.edit_spec?.aspect || 'auto';
  if (a === 'auto') {
    const w = job.probe_w || 720, h = job.probe_h || 1280;
    return { w, h };
  }
  const m = /^(\d+)x(\d+)$/.exec(a);
  return m ? { w: +m[1], h: +m[2] } : { w: 720, h: 1280 };
}

function buildFfmpegArgs(job, outPath, defaults = {}) {
  const imageDur = defaults.imageDur || 3;
  const fade = job.edit_spec?.fade ?? 0.35;
  const { w, h } = parseAspect(job, defaults);
  const clips = (job.edit_spec?.clips || []).slice().sort((a, b) => a.order - b.order);

  const inputs = [];
  const filters = [];
  const labels = [];
  clips.forEach((c, i) => {
    const m = job.media[c.index];
    if (m.type === 'image') {
      inputs.push('-loop', '1', '-t', String(imageDur), '-i', m.path);
    } else {
      inputs.push('-ss', String(c.start ?? 0), '-to', String(c.end ?? (c.start ?? 0) + (job.edit_spec?.segLen || 5)), '-i', m.path);
    }
    // 归一化：缩放进画布 + 补边 + 统一 sar/fps
    filters.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`
    );
    labels.push(`[v${i}]`);
  });

  // 段间 xfade 串联（简化：无音频交叉，图片段静音由 ffmpeg 处理；音频后续增强）
  const segLenDefault = job.edit_spec?.segLen || 5;
  const clipDur = (c) => (job.media[c.index]?.type === 'image'
    ? imageDur
    : (((c.end ?? 0) - (c.start ?? 0)) || segLenDefault));

  let filterComplex;
  if (labels.length === 1) {
    filterComplex = filters.join(';') + `;${labels[0]}copy[vout]`;
  } else {
    let cur = labels[0];
    const chain = [];
    let acc = clipDur(clips[0]); // 已合成时间线的累计时长
    clips.forEach((c, i) => {
      if (i === 0) return;
      const out = i === labels.length - 1 ? '[vout]' : `[x${i}]`;
      const offset = acc - fade; // 转场落在上一段末尾的 fade 处
      chain.push(`${cur}${labels[i]}xfade=transition=fade:duration=${fade}:offset=${Math.max(0, offset).toFixed(3)}${out}`);
      acc = acc + clipDur(c) - fade; // 交叉淡化后的新累计时长
      cur = out;
    });
    filterComplex = filters.concat(chain).join(';');
  }

  return {
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-movflags', '+faststart',
      outPath,
    ],
  };
}

async function render(job, outPath, deps) {
  const { args } = buildFfmpegArgs(job, outPath, deps.defaults || {});
  await deps.run('ffmpeg', args, deps.timeoutMs || 600000);
  return outPath;
}

module.exports = { buildFfmpegArgs, render };
