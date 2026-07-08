// test/poll.test.js —— 无真实 bot：fake bot(getUpdates 一次相册 + getFileUrl 指向本地小 http server) 驱动一次轮询，
// 断言任务建到 WORK_DIR/<id>/、caption 解析正确、manual 模式发出带签名的剪辑链接。
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
process.env.SIGN_SECRET = process.env.SIGN_SECRET || 'poll-test-secret';

const { createDb } = require('../lib/db');
const { sign } = require('../lib/sign');
const { pollOnce } = require('../telegram-poll');

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-poll-'));
  const db = createDb(path.join(workDir, 'jobs.sqlite'));

  const imgBytes = Buffer.from('fake-jpg-bytes');
  const vidBytes = Buffer.from('fake-mp4-bytes');
  const server = http.createServer((req, res) => {
    if (req.url === '/f/photo.jpg') return res.end(imgBytes);
    if (req.url === '/f/video.mp4') return res.end(vidBytes);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const sentMessages = [];
  const fakeBot = {
    async getUpdates() {
      return [
        { update_id: 1, message: { chat: { id: 555 }, message_id: 10, media_group_id: 'alb1',
            caption: '我的标题\n一些描述文字 #tag1 #tag2',
            photo: [{ file_id: 'p_small' }, { file_id: 'p_big' }] } },
        { update_id: 2, message: { chat: { id: 555 }, message_id: 11, media_group_id: 'alb1',
            video: { file_id: 'v1' } } },
      ];
    },
    async getFileUrl(fileId) {
      if (fileId === 'p_big') return `http://127.0.0.1:${port}/f/photo.jpg`;
      if (fileId === 'v1') return `http://127.0.0.1:${port}/f/video.mp4`;
      throw new Error('unknown file_id ' + fileId);
    },
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); return { ok: true }; },
    async sendVideo() { throw new Error('sendVideo 不应在 poll 阶段被调用'); },
  };

  const r = await pollOnce({ db, workDir, bot: fakeBot, mode: 'manual', publicBase: 'http://localhost:9999', offset: 0 });
  server.close();

  assert.strictEqual(r.offset, 3, 'offset 应推进到 max(update_id)+1');
  assert.strictEqual(r.jobs.length, 1, '一个相册应只建一个任务');

  const job = db.get(r.jobs[0].id);
  assert.strictEqual(job.status, 'editing', 'manual 模式任务应停在 editing 等待剪辑提交');
  assert.strictEqual(job.tg_chat_id, '555');
  assert.strictEqual(job.title, '我的标题');
  assert.ok(job.description.includes('一些描述文字'), 'description 应含正文: ' + job.description);
  assert.deepStrictEqual(job.tags, ['tag1', 'tag2']);
  assert.strictEqual(job.media.length, 2, '应下载 1 图 1 视频共 2 个素材');

  // MUST-FIX #1：素材必须落在 WORK_DIR/<job.id>/ 下，而不是 incoming-<media_group>/
  const jobDir = path.join(workDir, job.id) + path.sep;
  for (const m of job.media) {
    assert.ok(m.path.startsWith(jobDir), 'media 路径应在 WORK_DIR/<id>/ 下: ' + m.path);
    assert.ok(fs.existsSync(m.path), '素材文件应已下载到磁盘: ' + m.path);
  }
  assert.strictEqual(job.media[0].type, 'image');
  assert.strictEqual(job.media[1].type, 'video');
  assert.strictEqual(fs.readFileSync(job.media[0].path).toString(), 'fake-jpg-bytes');
  assert.strictEqual(fs.readFileSync(job.media[1].path).toString(), 'fake-mp4-bytes');

  // manual 模式应发出一条带正确签名的剪辑链接
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].chatId, 555);
  const expectedLink = `http://localhost:9999/edit?job=${job.id}&sign=${sign(job.id)}`;
  assert.ok(sentMessages[0].text.includes(expectedLink), '应含带签名的剪辑链接, got: ' + sentMessages[0].text);

  console.log('POLL_OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
