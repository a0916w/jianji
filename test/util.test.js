// test/util.test.js
const assert = require('node:assert');
const { sendJson, httpGet, run } = require('../lib/util');
const http = require('http');

(async () => {
  // sendJson 写正确 header + body
  let written = {};
  const fakeRes = { writeHead:(c,h)=>{written.code=c;written.h=h;}, end:(b)=>{written.body=b;} };
  sendJson(fakeRes, 200, { ok: true });
  assert.strictEqual(written.code, 200);
  assert.strictEqual(written.body, '{"ok":true}');

  // httpGet 拿到二进制
  const srv = http.createServer((q,s)=>{ s.writeHead(200); s.end(Buffer.from([1,2,3])); }).listen(34310);
  const g = await httpGet('http://127.0.0.1:34310/x');
  assert.strictEqual(g.status, 200);
  assert.ok(Buffer.isBuffer(g.buffer) && g.buffer.length === 3);
  srv.close();

  // run 执行 echo
  const r = await run('echo', ['hi'], 5000);
  assert.match(r.stdout, /hi/);
  console.log('UTIL_OK');
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
