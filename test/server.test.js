// test/server.test.js
process.env.SIGN_SECRET = 'sec';
process.env.WORK_DIR = require('os').tmpdir() + '/jj-srv-' + Date.now();
process.env.DB_PATH = process.env.WORK_DIR + '/jobs.sqlite';
process.env.PORT = '34320';
process.env.TELEGRAM_BOT_TOKEN = ''; // 不启轮询
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { app, db } = require('../server'); // server.js 导出 {app(http.Server), db}
const { sign } = require('../lib/sign');

function get(path) { return new Promise((res)=>{ http.get('http://127.0.0.1:34320'+path, r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));}); }); }
function post(path, obj){ return new Promise((res)=>{ const b=Buffer.from(JSON.stringify(obj)); const r=http.request('http://127.0.0.1:34320'+path,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':b.length}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d}));}); r.end(b); }); }

(async () => {
  fs.mkdirSync(process.env.WORK_DIR + '/1', { recursive: true });
  fs.writeFileSync(process.env.WORK_DIR + '/1/a.jpg', 'x');
  const job = db.create({ tg_chat_id: 'c', media: [{ type: 'image', path: process.env.WORK_DIR + '/1/a.jpg' }], title: 'T', description: 'D', tags: ['k'], mode: 'manual', status: 'editing' });
  const s = sign(job.id);

  // 签名错 → 403
  assert.strictEqual((await get(`/api/job?job=${job.id}&sign=bad`)).status, 403);
  // 正确 → 拿到 media url + 元数据
  const okr = await get(`/api/job?job=${job.id}&sign=${s}`);
  assert.strictEqual(okr.status, 200);
  const jj = JSON.parse(okr.body);
  assert.strictEqual(jj.title, 'T');
  assert.ok(jj.media[0].url.includes('/media/' + job.id + '/'));
  assert.ok(jj.media[0].url.includes('sign='));
  // 带签名的 media url 可正常拉取
  assert.strictEqual((await get(jj.media[0].url)).status, 200);
  // 不带签名拉取 media → 403
  assert.strictEqual((await get(`/media/${job.id}/a.jpg`)).status, 403);
  // 目录穿越被挡（带合法签名仍被拦，证明穿越校验独立生效）
  assert.strictEqual((await get(`/media/${job.id}/%2e%2e%2f%2e%2e%2fetc%2fpasswd?sign=${s}`)).status, 400);
  // submit：签名对 + editing → rendering
  const sub = await post('/api/submit', { job: job.id, sign: s, edit_spec: { aspect: 'auto', clips: [{ index: 0, order: 0 }] } });
  assert.strictEqual(sub.status, 200);
  assert.strictEqual(db.get(job.id).status, 'rendering');
  // 重复 submit（已不是 editing）→ 409
  assert.strictEqual((await post('/api/submit', { job: job.id, sign: s, edit_spec: {} })).status, 409);

  app.close();
  console.log('SERVER_OK');
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
