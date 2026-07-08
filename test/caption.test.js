const assert = require('node:assert');
const { parseCaption } = require('../lib/caption');

const r = parseCaption('绝世高手回归\n男主隐藏身份三年后霸气归来\n#热血 #逆袭 #热血');
assert.strictEqual(r.title, '绝世高手回归');
assert.strictEqual(r.description, '男主隐藏身份三年后霸气归来');
assert.deepStrictEqual(r.tags, ['热血', '逆袭']); // 去重

const empty = parseCaption('');
assert.strictEqual(empty.title, '');
assert.deepStrictEqual(empty.tags, []);

const onlyTitle = parseCaption('单标题');
assert.strictEqual(onlyTitle.title, '单标题');
assert.strictEqual(onlyTitle.description, '');
console.log('CAPTION_OK');
