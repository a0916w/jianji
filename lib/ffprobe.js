// lib/ffprobe.js —— 真实 ffmpeg/ffprobe 集成：时长探测、均匀抽帧(供 smartcut 用)、分辨率探测。
const { run } = require('./util');
const { spawn } = require('child_process');

async function ffprobeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 30000);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

async function ffprobeSize(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], 30000);
  const m = /(\d+)x(\d+)/.exec(stdout.trim());
  return m ? { w: +m[1], h: +m[2] } : { w: 720, h: 1280 };
}

// I2：探测文件是否含音轨(手机/录屏视频常见无音轨)。探测失败(如文件损坏)时保守返回 true
// （按"有音轨"处理，走原有逻辑），避免把探测异常和"确实无音轨"混为一谈而错误静音。
async function ffprobeHasAudio(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], 30000);
    return stdout.trim().length > 0;
  } catch (e) {
    return true;
  }
}

// 均匀抽 n 帧、48x27 灰度 raw；每帧 48*27=1296 字节。
// 先用 ffprobeDuration 校准 fps=n/duration，让 `-vf fps=` 均匀覆盖全片时长而非固定帧率。
function readFrames(file, n) {
  const W = 48, H = 27, frameBytes = W * H;
  return ffprobeDuration(file).then((duration) => new Promise((resolve, reject) => {
    const fps = duration > 0 ? Math.max(0.05, n / duration) : 1;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', `fps=${fps},scale=${W}:${H}`,
      '-frames:v', String(n), '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
    ];
    const ps = spawn('ffmpeg', args);
    const chunks = [];
    let settled = false;
    // M2：ffmpeg 卡死(如损坏/超大/网络挂载文件)时不能无限等，60s 后强杀并 reject，
    // 避免拖死轮询智能选段的整条 tick 链路。
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ps.kill('SIGKILL');
      reject(new Error(`readFrames: ffmpeg 超时(60s)未响应，已强制终止: ${file}`));
    }, 60000);
    ps.stdout.on('data', (c) => chunks.push(c));
    ps.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(e);
    });
    ps.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const buf = Buffer.concat(chunks);
      const frames = [];
      for (let i = 0; i + frameBytes <= buf.length; i += frameBytes) frames.push(buf.subarray(i, i + frameBytes));
      resolve(frames);
    });
  }));
}

module.exports = { ffprobeDuration, readFrames, ffprobeSize, ffprobeHasAudio };
