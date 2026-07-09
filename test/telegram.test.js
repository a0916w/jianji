const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { groupUpdates, createBot } = require('../lib/telegram');

const updates = [
  { message: { chat: { id: 10 }, message_id: 100, media_group_id: 'g1', caption: '标题\n#a',
      photo: [{ file_id: 'p_small' }, { file_id: 'p_big' }] } },
  { message: { chat: { id: 10 }, message_id: 101, media_group_id: 'g1',
      video: { file_id: 'v1' } } },
  { message: { chat: { id: 10 }, message_id: 102, media_group_id: 'g2',
      video: { file_id: 'v2' }, caption: '另一个' } },
];
const batches = groupUpdates(updates);
assert.strictEqual(batches.length, 2);
const g1 = batches.find(b => b.media_group === 'g1');
assert.strictEqual(g1.items.length, 2);
// 图片取最大尺寸那个 file_id
assert.ok(g1.items.some(it => it.type === 'image' && it.file_id === 'p_big'));
assert.ok(g1.items.some(it => it.type === 'video' && it.file_id === 'v1'));
assert.strictEqual(g1.caption, '标题\n#a'); // caption 取相册里有 caption 的那条

// sendVideoFile：应读本地文件字节，经注入的 httpPostMultipart 直传给 Telegram（而不是发 URL）。
(async () => {
  const tmpFile = path.join(os.tmpdir(), 'jj-tg-test-' + Date.now() + '.mp4');
  const fileBytes = Buffer.from('fake-mp4-bytes-for-test');
  fs.writeFileSync(tmpFile, fileBytes);

  let mpCall = null;
  const fakeDeps = {
    async httpGet() { throw new Error('不应调用 httpGet'); },
    async httpPostJson() { throw new Error('不应调用 httpPostJson'); },
    async httpPostMultipart(url, fields, fileField) {
      mpCall = { url, fields, fileField };
      return { status: 200, body: '{"ok":true}' };
    },
  };
  const bot = createBot('FAKETOKEN', fakeDeps);
  assert.strictEqual(typeof bot.sendVideoFile, 'function', 'createBot 应暴露 sendVideoFile');

  const r = await bot.sendVideoFile(12345, tmpFile, '标题描述');
  assert.strictEqual(r.status, 200);
  assert.ok(mpCall, 'httpPostMultipart 应被调用');
  assert.strictEqual(mpCall.url, `https://api.telegram.org/botFAKETOKEN/sendVideo`);
  assert.strictEqual(mpCall.fields.chat_id, '12345');
  assert.strictEqual(mpCall.fields.caption, '标题描述');
  assert.strictEqual(mpCall.fileField.name, 'video');
  assert.strictEqual(mpCall.fileField.filename, path.basename(tmpFile));
  assert.strictEqual(mpCall.fileField.contentType, 'video/mp4');
  assert.ok(Buffer.isBuffer(mpCall.fileField.buffer) && mpCall.fileField.buffer.equals(fileBytes), '应读取到临时文件的原始字节');

  fs.unlinkSync(tmpFile);
  console.log('TG_OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
