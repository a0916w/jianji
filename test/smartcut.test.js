const assert = require('node:assert');
const { pickSegment } = require('../lib/smartcut');

// times/scores：[1,3] 和 [2,4] 运动量并列最大（平局取靠前）
const times = [0,1,2,3,4];
const scores = [1,1,9,9,1];
const seg = pickSegment(scores, times, 2, 10);
assert.strictEqual(seg.start, 1);
assert.strictEqual(seg.end, 3);

// 全片短于 segLen：返回 [0,duration]（由调用方处理，此处窗口不越界）
const seg2 = pickSegment([5], [0], 2, 1);
assert.ok(seg2.start >= 0 && seg2.end <= 2);
console.log('SMARTCUT_OK');
