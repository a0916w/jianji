// test/poll-help.test.js —— 纯文本 /help 触发：pollOnce 应回复使用说明，且不建任务（无媒体）。
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SIGN_SECRET = process.env.SIGN_SECRET || 'poll-help-test-secret';

const { createDb } = require('../lib/db');
const { pollOnce } = require('../telegram-poll');

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-poll-help-'));
  const db = createDb(path.join(workDir, 'jobs.sqlite'));

  const sentMessages = [];
  const fakeBot = {
    async getUpdates() {
      return [
        { update_id: 1, message: { chat: { id: 5 }, message_id: 1, text: '/help' } },
      ];
    },
    async getFileUrl() { throw new Error('不应下载素材'); },
    async sendMessage(chatId, text) { sentMessages.push({ chatId, text }); return { ok: true }; },
  };

  const r = await pollOnce({ db, workDir, bot: fakeBot, mode: 'manual', publicBase: 'http://localhost:9998', offset: 0, botUsername: '' });

  assert.strictEqual(r.jobs.length, 0, '纯文本 /help 不应建任务');
  assert.strictEqual(sentMessages.length, 1, '应回复一条使用说明');
  assert.strictEqual(sentMessages[0].chatId, 5);
  assert.ok(sentMessages[0].text.includes('使用说明'), '回复内容应含"使用说明": ' + sentMessages[0].text);
  assert.ok(sentMessages[0].text.includes('当前模式：人工剪辑'), '回复应含当前模式(manual→人工剪辑): ' + sentMessages[0].text);

  console.log('POLL_HELP_OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
