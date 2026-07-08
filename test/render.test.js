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

// 3 段链:图片(3s) + 视频(0-6) + 视频(0-5),fade 0.35 → 第一转场 offset=2.650,第二转场 offset=8.300
const job3 = {
  media: [
    { type: 'image', path: '/w/i.jpg' },
    { type: 'video', path: '/w/a.mp4' },
    { type: 'video', path: '/w/b.mp4' },
  ],
  edit_spec: { aspect: '720x1280', segLen: 5, fade: 0.35, clips: [
    { index: 0, order: 0 },
    { index: 1, start: 0, end: 6, order: 1 },
    { index: 2, start: 0, end: 5, order: 2 },
  ]},
};
const s3 = require('../lib/render').buildFfmpegArgs(job3, '/w/out.mp4', { imageDur: 3 }).args.join(' ');
assert.ok(s3.includes('offset=2.650'), 'first xfade offset should be 2.650, got: ' + s3);
assert.ok(s3.includes('offset=8.300'), 'second xfade offset should be 8.300, got: ' + s3);

console.log('RENDER_OK');
