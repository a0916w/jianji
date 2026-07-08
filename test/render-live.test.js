// test/render-live.test.js —— 用真实 ffmpeg 生成一段带音频的视频 + 一张图片，喂给 worker 真渲染，
// 再用真实 ffprobe 校验成片同时有视频/音频流且时长符合预期(图片3s + 视频段5s - fade0.35 ≈ 7.6s)。
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function main() {
  if (!hasFfmpeg()) { console.log('RENDER_LIVE_SKIP'); return; }

  const { createDb } = require('../lib/db');
  const { ffprobeSize } = require('../lib/ffprobe');
  const { smartSegmentForVideo, pickSegment } = require('../lib/smartcut');
  const { ffprobeDuration, readFrames } = require('../lib/ffprobe');
  const worker = require('../worker');

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj10-assets-'));
  const vPath = path.join(assetDir, 'v.mp4');
  const iPath = path.join(assetDir, 'i.jpg');

  // 6 秒测试视频(带 440Hz 音调) + 1 帧测试图片
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-shortest', vPath]);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:size=320x240:d=1',
    '-frames:v', '1', iPath]);
  assert.ok(fs.existsSync(vPath) && fs.existsSync(iPath), '测试素材应生成成功');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj10-work-'));
  const db = createDb(path.join(workDir, 'jobs.sqlite'));

  // 先建任务拿到 id，再把素材落到 WORK_DIR/<id>/ 下（与 MUST-FIX #1 的目录口径一致）
  const job0 = db.create({ tg_chat_id: 'test', status: 'downloading', mode: 'auto' });
  const jobDir = path.join(workDir, job0.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const m0 = path.join(jobDir, 'm0.jpg');
  const m1 = path.join(jobDir, 'm1.mp4');
  fs.copyFileSync(iPath, m0);
  fs.copyFileSync(vPath, m1);

  const { w: probe_w, h: probe_h } = await ffprobeSize(m1);
  assert.strictEqual(probe_w, 320); assert.strictEqual(probe_h, 240);

  const segLen = 5;
  const seg = await smartSegmentForVideo(m1, segLen, { ffprobeDuration, readFrames });
  assert.ok(seg.end - seg.start > 0, 'smartcut 应选出非空区间, got ' + JSON.stringify(seg));

  const edit_spec = {
    aspect: 'auto', segLen, fade: 0.35,
    clips: [
      { index: 0, order: 0, type: 'image' },
      { index: 1, start: seg.start, end: seg.end, order: 1, type: 'video' },
    ],
  };
  const media = [{ type: 'image', path: m0 }, { type: 'video', path: m1 }];
  db.update(job0.id, { media, probe_w, probe_h, edit_spec, status: 'rendering' });

  const ctrl = worker.startWorker({ db, workDir });
  let job = db.get(job0.id);
  const deadline = Date.now() + 60000;
  while (!['done', 'failed'].includes(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    job = db.get(job0.id);
  }
  ctrl.stop();

  assert.strictEqual(job.status, 'done', 'worker 渲染应成功, error=' + job.error);
  const out = job.result_path;
  assert.ok(out && fs.existsSync(out), 'out.mp4 应存在: ' + out);
  assert.strictEqual(out, path.join(workDir, job0.id, 'out.mp4'), 'out.mp4 应落在 WORK_DIR/<id>/ 下');

  const probeJson = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString();
  console.log('--- ffprobe out.mp4 ---');
  console.log(probeJson);
  const info = JSON.parse(probeJson);
  const kinds = info.streams.map((s) => s.codec_type);
  assert.ok(kinds.includes('video'), '成片应含视频流, got ' + kinds.join(','));
  assert.ok(kinds.includes('audio'), '成片应含音频流, got ' + kinds.join(','));

  const dur = parseFloat(info.format.duration);
  const expected = 3 + (seg.end - seg.start) - 0.35; // imageDur(3) + 视频段 - fade
  assert.ok(Math.abs(dur - expected) < 0.5, `时长应≈${expected.toFixed(2)}s(±0.5), got ${dur}`);

  console.log(`RENDER_LIVE_OK duration=${dur.toFixed(3)}s expected≈${expected.toFixed(3)}s streams=${kinds.join(',')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
