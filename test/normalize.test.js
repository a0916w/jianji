// lib/normalize.ensureH264：注入 run 桩，验证「h264/图片不转码」「hevc 转码并替换原文件」。
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureH264 } = require('../lib/normalize');

(async () => {
  // 1) 已是 h264 → 不转码、不调 ffmpeg
  {
    const calls = [];
    const run = (cmd) => { calls.push(cmd); return Promise.resolve({ stdout: cmd === 'ffprobe' ? 'h264\n' : '' }); };
    const r = await ensureH264('/w/1/a.mp4', { run });
    assert.strictEqual(r, false, 'h264 不该转码');
    assert.ok(!calls.includes('ffmpeg'), 'h264 不该调 ffmpeg');
  }

  // 2) 无视频流（图片/探测空）→ false
  {
    const calls = [];
    const run = (cmd) => { calls.push(cmd); return Promise.resolve({ stdout: cmd === 'ffprobe' ? '\n' : '' }); };
    assert.strictEqual(await ensureH264('/w/1/a.jpg', { run }), false);
    assert.ok(!calls.includes('ffmpeg'), '无视频流不该调 ffmpeg');
  }

  // 3) hevc → 调 ffmpeg(libx264) 并就地替换原文件
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnorm-'));
    const file = path.join(dir, 'v.mp4');
    fs.writeFileSync(file, 'ORIGINAL-HEVC');
    let ffArgs = null;
    const run = (cmd, args) => {
      if (cmd === 'ffprobe') return Promise.resolve({ stdout: 'hevc\n' });
      if (cmd === 'ffmpeg') {
        ffArgs = args;
        fs.writeFileSync(args[args.length - 1], 'TRANSCODED-H264'); // 桩：产出临时文件
        return Promise.resolve({ stdout: '' });
      }
      return Promise.resolve({ stdout: '' });
    };
    const r = await ensureH264(file, { run });
    assert.strictEqual(r, true, 'hevc 应转码');
    assert.ok(ffArgs.includes('libx264'), 'ffmpeg 应用 libx264');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'TRANSCODED-H264', '原文件应被替换成 H.264 产物');
    assert.ok(!fs.existsSync(file + '.h264.mp4'), '临时文件应已 rename 掉');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4) 转码失败 → 抛出、清理临时文件、不动原文件
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnorm-'));
    const file = path.join(dir, 'v.mp4');
    fs.writeFileSync(file, 'ORIGINAL-HEVC');
    const run = (cmd, args) => {
      if (cmd === 'ffprobe') return Promise.resolve({ stdout: 'hevc\n' });
      if (cmd === 'ffmpeg') { fs.writeFileSync(args[args.length - 1], 'partial'); return Promise.reject(new Error('ffmpeg boom')); }
      return Promise.resolve({ stdout: '' });
    };
    await assert.rejects(() => ensureH264(file, { run }), /boom/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'ORIGINAL-HEVC', '失败不该动原文件');
    assert.ok(!fs.existsSync(file + '.h264.mp4'), '失败应清理临时文件');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('NORMALIZE_TEST_PASS');
})().catch((e) => { console.error('NORMALIZE_TEST_FAIL', e); process.exit(1); });
