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
// 音频：图片段静音源 + 视频段自身音轨 + concat 汇总输出 [aout] 并 -map 出去
assert.ok(s.includes('anullsrc'), '图片段应补静音音轨');
assert.ok(s.includes('[0:a]') === false, '图片输入(index 0)不应引用不存在的音轨 [0:a]');
assert.ok(s.includes('[1:a]'), '视频输入(index 1)应引用自身音轨');
assert.ok(s.includes('concat=n=2:v=0:a=1[aout]'), '音频应 concat 成 [aout]');
assert.ok(args.includes('[aout]') && args[args.indexOf('[aout]') - 1] === '-map', '应有 -map [aout]');
assert.ok(s.includes('-c:a aac'), '应设置音频编码器');

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

// I2：视频段 hasAudio===false（worker 探测到无音轨）时，不应引用不存在的 [i:a]，
// 而是像图片段一样用 anullsrc 静音轨兜底，音频链路(concat/[aout])依旧完整。
const jobSilent = {
  media: [
    { type: 'video', path: '/w/2/silent.mp4', hasAudio: false },
    { type: 'video', path: '/w/2/withaudio.mp4' }, // hasAudio 未设置 → 视为有音轨，走原逻辑
  ],
  edit_spec: {
    aspect: '720x1280', segLen: 5, fade: 0.35,
    clips: [
      { index: 0, start: 0, end: 4, order: 0 },
      { index: 1, start: 0, end: 4, order: 1 },
    ],
  },
};
const sSilent = require('../lib/render').buildFfmpegArgs(jobSilent, '/w/2/out.mp4', { imageDur: 3 }).args.join(' ');
assert.ok(sSilent.includes('anullsrc'), '无音轨视频段应补静音音轨');
assert.ok(sSilent.includes('[0:a]') === false, '无音轨视频(index 0)不应引用不存在的音轨 [0:a]');
assert.ok(sSilent.includes('[1:a]'), 'hasAudio 未标注为 false 的视频(index 1)应仍引用自身音轨 [1:a]');
assert.ok(sSilent.includes('concat=n=2:v=0:a=1[aout]'), '静音兜底后音频仍应正常 concat 成 [aout]');

console.log('RENDER_OK');
