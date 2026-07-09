// test/album-buffer.test.js —— 纯函数测试(注入时间戳，不依赖真实时钟)：
// 相册跨轮询累积 + 防抖判定就绪、单条消息立即就绪、同一 file_id 去重。
const assert = require('node:assert');
const { mergeIntoPending, takeReady } = require('../lib/album-buffer');

function main() {
  // 1) 相册跨两次轮询到达：第一次只有一张图，第二次补两条素材。
  {
    const pending = new Map();
    mergeIntoPending(pending, [
      { chat_id: 10, message_id: 100, media_group: 'g1', items: [{ type: 'image', file_id: 'a' }], caption: '标题' },
    ], 1000);
    mergeIntoPending(pending, [
      { chat_id: 10, message_id: 101, media_group: 'g1', items: [
        { type: 'video', file_id: 'b' },
        { type: 'video', file_id: 'c' },
      ], caption: '' },
    ], 1600);

    // 防抖未到：不该就绪
    let ready = takeReady(pending, 1600, 2500);
    assert.strictEqual(ready.length, 0, '防抖未到不应就绪');
    assert.ok(pending.has('g1'), '未就绪应仍留在 pending 里');

    // 自最后一次更新起静默满 2500ms：就绪，且三条素材合并成一个批次
    ready = takeReady(pending, 1600 + 2500, 2500);
    assert.strictEqual(ready.length, 1, '静默满 debounce 应恰好就绪一个批次');
    const batch = ready[0];
    assert.strictEqual(batch.media_group, 'g1');
    assert.strictEqual(batch.message_id, 100, 'message_id 应取两次里更小的');
    assert.strictEqual(batch.caption, '标题');
    assert.strictEqual(batch.items.length, 3, '应合并三条素材(A + B + C)');
    assert.deepStrictEqual(batch.items.map((i) => i.file_id).sort(), ['a', 'b', 'c']);
    assert.strictEqual(pending.size, 0, '就绪后应从 pending 里摘除');
  }

  // 2) 单条非相册消息应立即就绪，不受 debounce 影响。
  {
    const pending = new Map();
    mergeIntoPending(pending, [
      { chat_id: 20, message_id: 200, media_group: 'single-200', items: [{ type: 'image', file_id: 'x' }], caption: '' },
    ], 0);
    const ready = takeReady(pending, 0, 2500);
    assert.strictEqual(ready.length, 1, '单条消息应立即就绪');
    assert.strictEqual(ready[0].media_group, 'single-200');
    assert.strictEqual(pending.size, 0);
  }

  // 3) 同一 file_id 重复合并应去重。
  {
    const pending = new Map();
    mergeIntoPending(pending, [
      { chat_id: 30, message_id: 300, media_group: 'g3', items: [{ type: 'video', file_id: 'v1' }], caption: '' },
    ], 0);
    mergeIntoPending(pending, [
      { chat_id: 30, message_id: 301, media_group: 'g3', items: [{ type: 'video', file_id: 'v1' }], caption: '' },
    ], 100);
    const ready = takeReady(pending, 100, 0);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].items.length, 1, '重复 file_id 应去重, got: ' + JSON.stringify(ready[0].items));
  }

  console.log('ALBUM_BUFFER_OK');
}

main();
