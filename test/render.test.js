const assert = require('node:assert');
const { buildFfmpegArgs } = require('../lib/render');

const job = {
  media: [
    { type: 'image', path: '/w/1/a.jpg' },
    { type: 'video', path: '/w/1/b.mp4' },
  ],
  edit_spec: {
    aspect: '720x1280', segLen: 5, fade: 0.35,
    clips: [
      { index: 0, order: 0 },                    // 图片
      { index: 1, start: 2, end: 7, order: 1 },  // 视频段
    ],
  },
};
const { args } = buildFfmpegArgs(job, '/w/1/out.mp4', { imageDur: 3 });
const s = args.join(' ');
// 两个输入都在
assert.ok(s.includes('/w/1/a.jpg'));
assert.ok(s.includes('/w/1/b.mp4'));
// 图片 loop + 时长 3
assert.ok(s.includes('-loop 1'));
assert.ok(s.includes('-t 3'));
// 视频截取
assert.ok(s.includes('-ss 2'));
// 输出分辨率进了 scale/pad 滤镜
assert.ok(s.includes('720') && s.includes('1280'));
// 输出路径在最后
assert.strictEqual(args[args.length - 1], '/w/1/out.mp4');
console.log('RENDER_OK');
