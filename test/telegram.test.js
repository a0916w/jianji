const assert = require('node:assert');
const { groupUpdates } = require('../lib/telegram');

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
console.log('TG_OK');
