// test/edit-states.test.js —— 剪辑页状态感知的 API 契约（DOM 行为无法无头测试，
// 这里只断言驱动 UI 决策的 /api/job 数据本身正确：status/source/result 按任务状态区分）。
process.env.SIGN_SECRET = 'sec';
process.env.WORK_DIR = require('os').tmpdir() + '/jj-editstates-' + Date.now();
process.env.DB_PATH = process.env.WORK_DIR + '/jobs.sqlite';
process.env.PORT = '34321';
process.env.TELEGRAM_BOT_TOKEN = ''; // 不启轮询
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { app, db } = require('../server');
const { sign } = require('../lib/sign');

function get(path) { return new Promise((res)=>{ http.get('http://127.0.0.1:34321'+path, r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));}); }); }

(async () => {
  // 三个状态各造一个任务：editing（待剪辑）、rendering（进行中，锁定）、done（成品已在盘上）
  const editingJob = db.create({ tg_chat_id: 'c', media: [], title: 'E', status: 'editing', source: 'web' });
  const renderingJob = db.create({ tg_chat_id: 'c', media: [], title: 'R', status: 'rendering', source: 'telegram' });
  const doneJob = db.create({ tg_chat_id: 'c', media: [], title: 'D', status: 'done', source: 'telegram' });
  fs.mkdirSync(process.env.WORK_DIR + '/' + doneJob.id, { recursive: true });
  fs.writeFileSync(process.env.WORK_DIR + '/' + doneJob.id + '/out.mp4', 'fake-mp4-bytes');

  // editing：待剪辑，无成品
  {
    const s = sign(editingJob.id);
    const r = await get(`/api/job?job=${editingJob.id}&sign=${s}`);
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.status, 'editing');
    assert.strictEqual(j.source, 'web');
    assert.strictEqual(j.result, null);
  }

  // rendering：进行中，应锁定（无 result，前端据此禁用提交按钮）
  {
    const s = sign(renderingJob.id);
    const r = await get(`/api/job?job=${renderingJob.id}&sign=${s}`);
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.status, 'rendering');
    assert.strictEqual(j.source, 'telegram');
    assert.strictEqual(j.result, null);
  }

  // done：已完成，result 指向磁盘上真实存在的 out.mp4，带签名
  {
    const s = sign(doneJob.id);
    const r = await get(`/api/job?job=${doneJob.id}&sign=${s}`);
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.status, 'done');
    assert.strictEqual(j.source, 'telegram');
    assert.ok(j.result.includes(`/media/${doneJob.id}/out.mp4?sign=`));
    // result 链接可实际下载到刚写的成品文件
    const dl = await get(j.result);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.body, 'fake-mp4-bytes');
  }

  app.close();
  console.log('EDIT_STATES_OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
