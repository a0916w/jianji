// test/webjobs.test.js —— 网页上传落库+服务端渲染 / /jobs 管理列表 / submit 支持重剪
process.env.SIGN_SECRET = 'sec';
process.env.ADMIN_TOKEN = 'adm-secret';
process.env.WORK_DIR = require('os').tmpdir() + '/jj-webjobs-' + Date.now();
process.env.DB_PATH = process.env.WORK_DIR + '/jobs.sqlite';
process.env.PORT = '34321';
process.env.TELEGRAM_BOT_TOKEN = ''; // 不启轮询
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, db } = require('../server');
const { sign } = require('../lib/sign');

const BASE = 'http://127.0.0.1:34321';
function get(p) { return new Promise((res) => { http.get(BASE + p, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); }); }); }
function post(p, obj) { return new Promise((res) => { const b = Buffer.from(JSON.stringify(obj)); const r = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); }); r.end(b); }); }
function postRaw(p, buf) { return new Promise((res) => { const r = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length } }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); }); r.end(buf); }); }

(async () => {
  // -------- /jobs admin token gate --------
  const seeded = db.create({ tg_chat_id: 'c', media: [], title: '种子任务', mode: 'manual', status: 'editing', source: 'telegram' });

  assert.strictEqual((await get('/jobs')).status, 403); // 无 token
  assert.strictEqual((await get('/jobs?token=wrong')).status, 403); // 错 token

  const listOk = await get('/jobs?token=adm-secret');
  assert.strictEqual(listOk.status, 200);
  assert.ok(listOk.body.includes('种子任务'), 'jobs 列表应包含种子任务标题');
  assert.ok(listOk.body.includes(`/edit?job=${seeded.id}&sign=`), 'jobs 列表应包含剪辑链接');

  // -------- web 上传落库流程 --------
  const wj = await post('/api/web-job', { title: '网页任务', description: 'd', tags: ['a'] });
  assert.strictEqual(wj.status, 200);
  const wjBody = JSON.parse(wj.body);
  assert.ok(wjBody.ok && wjBody.id && wjBody.sign);
  const wjId = wjBody.id, wjSign = wjBody.sign;
  assert.strictEqual(db.get(wjId).source, 'web');
  assert.strictEqual(db.get(wjId).status, 'editing');

  // 极简 1x1 jpg 字节（不需要真的合法可解码，只测存盘+入库）
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]);
  const up = await postRaw(`/api/web-upload?job=${wjId}&sign=${wjSign}&name=a.jpg`, fakeJpg);
  assert.strictEqual(up.status, 200);
  const upBody = JSON.parse(up.body);
  assert.strictEqual(upBody.ok, true);
  assert.strictEqual(upBody.name, 'a.jpg');
  const afterUpload = db.get(wjId);
  assert.strictEqual(afterUpload.media.length, 1);
  assert.strictEqual(afterUpload.media[0].type, 'image');
  assert.ok(fs.existsSync(afterUpload.media[0].path), '上传文件应落盘');

  // 不允许的扩展名 → 400
  const badUp = await postRaw(`/api/web-upload?job=${wjId}&sign=${wjSign}&name=x.exe`, Buffer.from('x'));
  assert.strictEqual(badUp.status, 400);
  assert.strictEqual(db.get(wjId).media.length, 1); // 未追加

  // submit：editing → rendering
  const sub = await post('/api/submit', { job: wjId, sign: wjSign, edit_spec: { aspect: 'auto', clips: [{ index: 0, order: 0 }] } });
  assert.strictEqual(sub.status, 200);
  assert.strictEqual(db.get(wjId).status, 'rendering');

  // -------- 重剪闸门：done/failed 可重剪，进行中态拒绝 --------
  const doneJob = db.create({ media: [], mode: 'manual', status: 'done', source: 'web', title: '已完成' });
  const doneSign = sign(doneJob.id);
  const subDone = await post('/api/submit', { job: doneJob.id, sign: doneSign, edit_spec: { aspect: 'auto', clips: [] } });
  assert.strictEqual(subDone.status, 200);
  assert.strictEqual(db.get(doneJob.id).status, 'rendering');

  const procJob = db.create({ media: [], mode: 'manual', status: 'processing', source: 'web', title: '处理中' });
  const procSign = sign(procJob.id);
  const subProc = await post('/api/submit', { job: procJob.id, sign: procSign, edit_spec: { aspect: 'auto', clips: [] } });
  assert.strictEqual(subProc.status, 409);
  assert.strictEqual(db.get(procJob.id).status, 'processing'); // 未被改动

  app.close();
  console.log('WEBJOBS_OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
