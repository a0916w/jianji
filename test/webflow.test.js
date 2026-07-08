// test/webflow.test.js —— 端到端复现前端「⬆ 生成到服务器」按钮的真实调用序列：
// /api/web-job → 逐个 /api/web-upload（原始字节，保序）→ /api/submit → worker 真渲染 → 校验 out.mp4。
process.env.SIGN_SECRET = process.env.SIGN_SECRET || 'sec';
process.env.WORK_DIR = require('os').tmpdir() + '/jj-webflow-' + Date.now();
process.env.DB_PATH = process.env.WORK_DIR + '/jobs.sqlite';
process.env.PORT = '34322';
process.env.TELEGRAM_BOT_TOKEN = ''; // 不启轮询/不接 bot

const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = 'http://127.0.0.1:34322';

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function post(p, obj) {
  return new Promise((resolve) => {
    const b = Buffer.from(JSON.stringify(obj));
    const r = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } },
      (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => resolve({ status: x.statusCode, body: d })); });
    r.end(b);
  });
}

function postRawFile(p, filePath) {
  return new Promise((resolve) => {
    const buf = fs.readFileSync(filePath);
    const r = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length } },
      (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => resolve({ status: x.statusCode, body: d })); });
    r.end(buf);
  });
}

async function main() {
  if (!hasFfmpeg()) { console.log('WEBFLOW_SKIP'); return; }

  const { app, db } = require('../server');
  const { startWorker } = require('../worker');

  // -------- 真实素材：一张 jpg + 一段带 440Hz 音调的 2 秒 mp4 --------
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-webflow-assets-'));
  const imgPath = path.join(assetDir, 'a.jpg');
  const vidPath = path.join(assetDir, 'b.mp4');
  const VID_DUR = 2;

  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:size=320x240:d=1',
    '-frames:v', '1', imgPath]);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${VID_DUR}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${VID_DUR}`,
    '-shortest', vidPath]);
  assert.ok(fs.existsSync(imgPath) && fs.existsSync(vidPath), '测试素材应生成成功');

  // -------- 复现前端按钮点击的确切调用序列 --------
  // 1) POST /api/web-job {}
  const jr = await post('/api/web-job', {});
  assert.strictEqual(jr.status, 200);
  const jd = JSON.parse(jr.body);
  assert.ok(jd.ok && jd.id && jd.sign, 'web-job 应返回 id+sign');
  const id = jd.id, sig = jd.sign;
  assert.strictEqual(db.get(id).source, 'web');
  assert.strictEqual(db.get(id).status, 'editing');

  // 2) 逐个原始字节上传，顺序 = 图片(index0) → 视频(index1)，与前端 clips 顺序一致
  const files = [
    { path: imgPath, name: 'a.jpg' },
    { path: vidPath, name: 'b.mp4' },
  ];
  for (const f of files) {
    const ur = await postRawFile(`/api/web-upload?job=${id}&sign=${sig}&name=${encodeURIComponent(f.name)}`, f.path);
    assert.strictEqual(ur.status, 200, `上传 ${f.name} 应成功: ` + ur.body);
    const ud = JSON.parse(ur.body);
    assert.strictEqual(ud.ok, true);
    assert.strictEqual(ud.name, f.name);
  }
  const afterUpload = db.get(id);
  assert.strictEqual(afterUpload.media.length, 2, '两个文件都应落库');
  assert.strictEqual(afterUpload.media[0].type, 'image', '上传顺序应保留：media[0]=图片');
  assert.strictEqual(afterUpload.media[1].type, 'video', '上传顺序应保留：media[1]=视频');

  // 3) POST /api/submit：index 指向服务端 media 数组（= 上传顺序）
  const edit_spec = {
    aspect: 'auto', segLen: 5, fade: 0.35,
    clips: [
      { index: 0, order: 0, type: 'image' },
      { index: 1, start: 0, end: VID_DUR, order: 1, type: 'video' },
    ],
  };
  const sr = await post('/api/submit', { job: id, sign: sig, edit_spec });
  assert.strictEqual(sr.status, 200);
  const sd = JSON.parse(sr.body);
  assert.strictEqual(sd.ok, true);
  assert.strictEqual(db.get(id).status, 'rendering');

  // 4) 启动真实 worker，等待任务渲染完成
  const ctrl = startWorker({ db, workDir: process.env.WORK_DIR });
  let job = db.get(id);
  const deadline = Date.now() + 60000;
  while (!['done', 'failed'].includes(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    job = db.get(id);
  }
  ctrl.stop();

  assert.strictEqual(job.status, 'done', 'worker 渲染应成功, error=' + job.error);
  assert.strictEqual(job.source, 'web', 'db.get(id).source 应为 web');
  const out = path.join(process.env.WORK_DIR, id, 'out.mp4');
  assert.ok(fs.existsSync(out), 'out.mp4 应存在: ' + out);
  assert.strictEqual(job.result_path, out);

  // 5) ffprobe 校验成片同时含视频/音频流
  const probeJson = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString();
  const info = JSON.parse(probeJson);
  const kinds = info.streams.map((s) => s.codec_type);
  assert.ok(kinds.includes('video'), '成片应含视频流, got ' + kinds.join(','));
  assert.ok(kinds.includes('audio'), '成片应含音频流, got ' + kinds.join(','));

  app.close();
  console.log(`WEBFLOW_OK job=${id} duration=${parseFloat(info.format.duration).toFixed(2)}s streams=${kinds.join(',')}`);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
