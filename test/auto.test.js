// test/auto.test.js —— AUTO 模式端到端：真实 ffmpeg 生成素材(视频运动窗口可预测) + fake bot 驱动一次轮询，
// 断言 auto 模式直接建 status:'rendering' 的任务(不发剪辑链接)、edit_spec.clips 含图片(order0)+
// 智能选段落在视频的高运动区间(而非静止区间)，再走真实 worker 渲染出 out.mp4 并用真实 ffprobe 校验。
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

process.env.EDIT_MODE = 'auto';
process.env.SIGN_SECRET = process.env.SIGN_SECRET || 'auto-test-secret';
process.env.TELEGRAM_BOT_TOKEN = '';

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function main() {
  if (!hasFfmpeg()) { console.log('AUTO_SKIP'); return; }

  const { createDb } = require('../lib/db');
  const { pollOnce } = require('../telegram-poll');
  const worker = require('../worker');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-auto-work-'));
  process.env.WORK_DIR = workDir;
  const dbPath = path.join(workDir, 'jobs.sqlite');
  process.env.DB_PATH = dbPath;
  const db = createDb(dbPath);

  // 源素材目录：图片 + 一段"前7秒静止(黑屏)、后5秒高运动(testsrc)"共12秒、带 440Hz 音调的视频。
  // segLen 默认 5s，最佳窗口理应落在 7-12s 的高运动区间(start 明显 >=5)，而不是 0-7s 静止区间。
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-auto-src-'));
  const vPath = path.join(srcDir, 'v.mp4');
  const iPath = path.join(srcDir, 'i.jpg');

  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=7',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]',
    '-map', '[v]', '-map', '2:a', '-pix_fmt', 'yuv420p', '-shortest', vPath]);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:size=320x240:d=1',
    '-frames:v', '1', iPath]);
  assert.ok(fs.existsSync(vPath) && fs.existsSync(iPath), '测试源素材应生成成功');

  // 本地小 http server 供 fake bot 的 getFileUrl 下载
  const server = http.createServer((req, res) => {
    if (req.url === '/f/photo.jpg') return fs.createReadStream(iPath).pipe(res);
    if (req.url === '/f/video.mp4') return fs.createReadStream(vPath).pipe(res);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const sentMessages = [];
  const sentVideos = [];
  const fakeBot = {
    async getUpdates() {
      return [
        { update_id: 1, message: { chat: { id: 777 }, message_id: 20, media_group_id: 'alb-auto',
            caption: 'auto 标题\n自动剪辑正文 #autotag',
            photo: [{ file_id: 'p_small' }, { file_id: 'p_big' }] } },
        { update_id: 2, message: { chat: { id: 777 }, message_id: 21, media_group_id: 'alb-auto',
            video: { file_id: 'v1' } } },
      ];
    },
    async getFileUrl(fileId) {
      if (fileId === 'p_big') return `http://127.0.0.1:${port}/f/photo.jpg`;
      if (fileId === 'v1') return `http://127.0.0.1:${port}/f/video.mp4`;
      throw new Error('unknown file_id ' + fileId);
    },
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); return { ok: true }; },
    async sendVideo(chatId, url, caption) { sentVideos.push({ chatId, url, caption }); return { ok: true }; },
    // 回传成品现在走 multipart 直传文件（见 worker.js deliverResult），不再用 sendVideo(URL)。
    async sendVideoFile(chatId, filePath, caption) { sentVideos.push({ chatId, filePath, caption }); return { ok: true }; },
  };

  const publicBase = 'http://localhost:9998';
  const r = await pollOnce({ db, workDir, bot: fakeBot, mode: 'auto', publicBase, offset: 0 });
  server.close();

  assert.strictEqual(r.offset, 3, 'offset 应推进到 max(update_id)+1');
  assert.strictEqual(r.jobs.length, 1, '一个相册应只建一个任务');

  let job = db.get(r.jobs[0].id);
  assert.strictEqual(job.mode, 'auto');
  assert.strictEqual(job.status, 'rendering', 'auto 模式任务应直接进入 rendering(不停在 editing 等剪辑)');
  assert.strictEqual(job.title, 'auto 标题');
  assert.ok(job.description.includes('自动剪辑正文'), 'description 应含正文: ' + job.description);

  // auto 模式不发剪辑链接：sendMessage 要么没被调用，要么调用内容里不含 /edit?job=
  for (const m of sentMessages) {
    assert.ok(!/\/edit\?job=/.test(m.text), 'auto 模式不应发送带 /edit?job= 的剪辑链接, got: ' + m.text);
  }

  // edit_spec 校验：图片 order0，视频段 order1，start/end 为数值且落在高运动区间(>=5, 即不是静止的 0-7s)
  assert.ok(job.edit_spec, 'auto 任务应带 edit_spec');
  const clips = job.edit_spec.clips;
  assert.strictEqual(clips.length, 2, 'clips 应含图片+视频共 2 条');
  const imgClip = clips.find((c) => c.type === 'image');
  const vidClip = clips.find((c) => c.type === 'video');
  assert.ok(imgClip, '应含图片 clip');
  assert.strictEqual(imgClip.order, 0, '图片应排在最前(片头)');
  assert.ok(vidClip, '应含视频 clip');
  assert.strictEqual(vidClip.order, 1);
  assert.ok(Number.isFinite(vidClip.start) && Number.isFinite(vidClip.end), 'video clip 应有数值 start/end, got ' + JSON.stringify(vidClip));
  assert.ok(vidClip.end > vidClip.start, 'video clip end 应大于 start');
  assert.ok(vidClip.start >= 5, `智能选段应落在高运动区间(start>=5, 而非静止的 0-7s), got start=${vidClip.start}`);
  console.log('[auto] smartcut segment:', JSON.stringify(vidClip));

  // 走真实 worker 渲染
  worker.setBot(fakeBot, null, publicBase);
  const ctrl = worker.startWorker({ db, workDir });
  const deadline = Date.now() + 60000;
  while (!['done', 'failed'].includes(job.status) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 300));
    job = db.get(job.id);
  }
  ctrl.stop();

  assert.strictEqual(job.status, 'done', 'auto 任务渲染应成功, error=' + job.error);
  const out = job.result_path;
  assert.ok(out && fs.existsSync(out), 'out.mp4 应存在: ' + out);
  assert.strictEqual(out, path.join(workDir, job.id, 'out.mp4'));

  const probeJson = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString();
  const info = JSON.parse(probeJson);
  const kinds = info.streams.map((s) => s.codec_type);
  assert.ok(kinds.includes('video'), '成片应含视频流, got ' + kinds.join(','));

  // 渲染完成后 worker 应把成片经 sendVideoFile 直传文件回传(auto/manual 都走同一 deliverResult)
  assert.strictEqual(sentVideos.length, 1, '渲染完成应回传一次成片');
  assert.strictEqual(sentVideos[0].filePath, out, 'sendVideoFile 应传入成片的实际文件路径: ' + sentVideos[0].filePath);

  console.log('AUTO_OK', JSON.stringify({ jobId: job.id, seg: vidClip, duration: info.format.duration, streams: kinds }));
}

main().catch((e) => { console.error(e); process.exit(1); });
