// test/util.test.js
const assert = require('node:assert');
const { sendJson, httpGet, run, httpPostMultipart } = require('../lib/util');
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

  // httpPostMultipart：手搓的 multipart/form-data body 要能被"标准"服务端解析出字段值+文件字节，
  // header 要带正确 boundary，Content-Length 要跟实际 body 长度一致。
  let captured = null;
  const mpSrv = http.createServer((q, s) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      captured = { headers: q.headers, body: Buffer.concat(chunks) };
      s.writeHead(200); s.end('{"ok":true}');
    });
  }).listen(34311);
  await new Promise((resolve) => mpSrv.once('listening', resolve));

  const fileBuffer = Buffer.from([0x00, 0x01, 0xff, 0x42, 0x89, 0x50]); // 含非 utf8 字节，验证是二进制安全的
  const mp = await httpPostMultipart('http://127.0.0.1:34311/upload', { chat_id: '123', caption: '你好' },
    { name: 'video', filename: 'clip.mp4', contentType: 'video/mp4', buffer: fileBuffer });
  mpSrv.close();

  assert.strictEqual(mp.status, 200);
  assert.match(captured.headers['content-type'], /^multipart\/form-data; boundary=[0-9a-f]{32}$/);
  const boundary = captured.headers['content-type'].split('boundary=')[1];
  assert.strictEqual(Number(captured.headers['content-length']), captured.body.length, 'Content-Length 应与实际 body 长度一致');
  const bodyStr = captured.body.toString('latin1'); // latin1 逐字节映射，不破坏二进制内容的可搜索性
  assert.ok(bodyStr.includes(`--${boundary}`), 'body 应含 boundary 标记');
  assert.ok(bodyStr.includes('name="chat_id"') && bodyStr.includes('123'), 'body 应含 chat_id 字段值');
  assert.ok(bodyStr.includes('name="video"; filename="clip.mp4"'), 'body 应含文件字段的 filename');
  assert.ok(bodyStr.includes('Content-Type: video/mp4'), 'body 应含文件字段的 Content-Type');
  // 文件字节应完整出现在 body 里（binary-safe，不能被当成文本截断/转义）
  assert.ok(captured.body.includes(fileBuffer), '文件二进制内容应原样出现在 body 里');
  assert.ok(bodyStr.trim().endsWith(`--${boundary}--`), 'body 应以结束 boundary 收尾');

  console.log('MULTIPART_OK');
  console.log('UTIL_OK');
})().catch(e=>{ console.error('FAIL', e); process.exit(1); });
