// test/album-split.test.js —— 集成测试：还原真实 Telegram 行为——一个相册被拆到两次 getUpdates 里返回。
// fake bot 第一次只回 1 条(gg 相册的 video1)，第二次才回另外 2 条(video2 + image1)，第三次回空。
// 用调用方持有的常驻 pending Map 跨三次 pollOnce 调用，配合极短 ALBUM_DEBOUNCE_MS，断言最终只建 1 个
// 任务且含 3 条素材 —— 而不是拆成 2~3 个任务(修复前的 bug)。
process.env.ALBUM_DEBOUNCE_MS = '50';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
process.env.SIGN_SECRET = process.env.SIGN_SECRET || 'album-split-secret';

const { createDb } = require('../lib/db');
const { pollOnce } = require('../telegram-poll');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-split-'));
  const db = createDb(path.join(workDir, 'jobs.sqlite'));

  const vidBytes1 = Buffer.from('fake-mp4-1');
  const vidBytes2 = Buffer.from('fake-mp4-2');
  const imgBytes = Buffer.from('fake-jpg-1');
  const server = http.createServer((req, res) => {
    if (req.url === '/f/v1.mp4') return res.end(vidBytes1);
    if (req.url === '/f/v2.mp4') return res.end(vidBytes2);
    if (req.url === '/f/i1.jpg') return res.end(imgBytes);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let call = 0;
  const sentMessages = [];
  const fakeBot = {
    async getUpdates() {
      call++;
      if (call === 1) {
        // 第一次长轮询：相册第一条(video1)先到。
        return [
          { update_id: 1, message: { chat: { id: 999 }, message_id: 50, media_group_id: 'gg',
              caption: '跨轮询相册\n描述文字 #split',
              video: { file_id: 'v1' } } },
        ];
      }
      if (call === 2) {
        // 第二次长轮询：剩下 2 条(video2 + image1) 才到。
        return [
          { update_id: 2, message: { chat: { id: 999 }, message_id: 51, media_group_id: 'gg',
              video: { file_id: 'v2' } } },
          { update_id: 3, message: { chat: { id: 999 }, message_id: 52, media_group_id: 'gg',
              photo: [{ file_id: 'i1_small' }, { file_id: 'i1' }] } },
        ];
      }
      return []; // 之后没有新消息，靠防抖满足后自然落地
    },
    async getFileUrl(fileId) {
      const map = { v1: `http://127.0.0.1:${port}/f/v1.mp4`, v2: `http://127.0.0.1:${port}/f/v2.mp4`, i1: `http://127.0.0.1:${port}/f/i1.jpg` };
      if (map[fileId]) return map[fileId];
      throw new Error('unknown file_id ' + fileId);
    },
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); return { ok: true }; },
    async sendVideo() { throw new Error('sendVideo 不应在 poll 阶段被调用'); },
  };

  const pending = new Map(); // 常驻缓冲区，跨三次 pollOnce 调用复用（模拟 startPolling 里的 pending）
  let offset = 0;
  const opts = { db, workDir, bot: fakeBot, mode: 'manual', publicBase: 'http://localhost:9997' };

  // 第一次轮询：只拿到 video1，相册未到齐 → 不该建任务
  let r = await pollOnce({ ...opts, offset, pending });
  offset = r.offset;
  assert.strictEqual(r.jobs.length, 0, '第一次轮询相册未到齐，不应建任务');

  await sleep(20);

  // 第二次轮询：拿到剩下 2 条，凑齐 3 条素材，但刚更新 lastTs，防抖(50ms)还没到 → 仍不该建任务
  r = await pollOnce({ ...opts, offset, pending });
  offset = r.offset;
  assert.strictEqual(r.jobs.length, 0, '第二次轮询刚补齐素材，防抖未到不应建任务');

  await sleep(80); // 超过 50ms 防抖窗口

  // 第三次轮询：getUpdates 返回空，但静默已超过防抖 → 应该落地建任务
  r = await pollOnce({ ...opts, offset, pending });
  offset = r.offset;
  assert.strictEqual(r.jobs.length, 1, '静默超过防抖后，即使本轮 getUpdates 为空也应落地建 1 个任务');
  assert.strictEqual(pending.size, 0, '落地后 pending 应清空');

  const job = db.get(r.jobs[0].id);
  assert.strictEqual(job.media.length, 3, '3 条素材应合并进同一个任务, got ' + job.media.length);
  assert.strictEqual(job.media.filter((m) => m.type === 'video').length, 2, '应含 2 条视频');
  assert.strictEqual(job.media.filter((m) => m.type === 'image').length, 1, '应含 1 条图片');
  assert.strictEqual(job.title, '跨轮询相册');

  // 全程只应该建这一个任务（没有被拆成 2~3 个）
  const allJobs = db.listAll();
  assert.strictEqual(allJobs.length, 1, '整个过程应只建 1 个任务, got ' + allJobs.length);

  server.close();
  console.log('ALBUM_SPLIT_OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
