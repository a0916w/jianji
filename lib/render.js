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
  const segLenDefault = job.edit_spec?.segLen || 5;
  const clipDur = (c) => (job.media[c.index]?.type === 'image'
    ? imageDur
    : (((c.end ?? 0) - (c.start ?? 0)) || segLenDefault));

  const inputs = [];
  const filters = [];
  const labels = [];
  const afilters = []; // 每段音频：视频段用自身音轨（随 -ss/-to 一起被裁剪），图片段用等长静音
  const alabels = [];
  clips.forEach((c, i) => {
    const m = job.media[c.index];
    const dur = clipDur(c);
    // 音频硬切 concat 没有 xfade 的交叉重叠，所以每段(除第一段外)只取 dur-fade 秒，
    // 使音频总时长与视频经 xfade 缩短后的时间线一致（否则音频会比画面长出 N*fade 秒，越拼越不同步）。
    const audioDur = i === 0 ? dur : Math.max(0.05, dur - fade);
    if (m.type === 'image') {
      inputs.push('-loop', '1', '-t', String(imageDur), '-i', m.path);
      afilters.push(
        `anullsrc=r=44100:cl=stereo,atrim=0:${audioDur},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
      );
    } else if (m.hasAudio === false) {
      // I2：视频没有音轨（手机/录屏常见）。buildFfmpegArgs 本身不探测文件，
      // 依赖调用方（worker.js 用 ffprobeHasAudio）提前在 job.media[i].hasAudio 上标注好；
      // 无音轨时不能引用 [i:a]（ffmpeg 会因流不存在而整体报错），改用静音轨兜底，
      // 与图片段一致，保证音频 concat 链路始终成立。
      inputs.push('-ss', String(c.start ?? 0), '-to', String(c.end ?? (c.start ?? 0) + segLenDefault), '-i', m.path);
      afilters.push(
        `anullsrc=r=44100:cl=stereo,atrim=0:${audioDur},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
      );
    } else {
      inputs.push('-ss', String(c.start ?? 0), '-to', String(c.end ?? (c.start ?? 0) + segLenDefault), '-i', m.path);
      afilters.push(
        `[${i}:a]atrim=0:${audioDur},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`
      );
    }
    // 归一化：缩放进画布 + 补边 + 统一 sar/fps
    filters.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`
    );
    labels.push(`[v${i}]`);
    alabels.push(`[a${i}]`);
  });

  // 视频段间 xfade 串联
  let videoFilterComplex;
  if (labels.length === 1) {
    videoFilterComplex = filters.join(';') + `;${labels[0]}copy[vout]`;
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
    videoFilterComplex = filters.concat(chain).join(';');
  }

  // 音频：Phase 1 简单硬切 concat（不做 acrossfade），拼成与视频时间线对齐的整段音轨
  const audioConcat = `${alabels.join('')}concat=n=${alabels.length}:v=0:a=1[aout]`;
  const filterComplex = [videoFilterComplex, afilters.join(';'), audioConcat].filter(Boolean).join(';');

  return {
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-ar', '44100', '-b:a', '128k',
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
