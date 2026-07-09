function groupUpdates(updates) {
  const byGroup = new Map();
  const singles = [];
  for (const u of updates) {
    const m = u.message; if (!m) continue;
    let item = null;
    if (m.video) item = { type: 'video', file_id: m.video.file_id };
    else if (m.photo && m.photo.length) item = { type: 'image', file_id: m.photo[m.photo.length - 1].file_id }; // 最大尺寸
    else if (m.document && ['image/jpeg','image/png','image/webp','video/mp4'].includes(m.document.mime_type)) {
      item = { type: m.document.mime_type.startsWith('video') ? 'video' : 'image', file_id: m.document.file_id };
    }
    if (!item) continue;
    const base = { chat_id: m.chat.id, message_id: m.message_id, caption: m.caption || '' };
    if (m.media_group_id) {
      const g = byGroup.get(m.media_group_id) || { chat_id: m.chat.id, message_id: m.message_id, media_group: m.media_group_id, items: [], caption: '' };
      g.items.push(item);
      if (m.caption) g.caption = m.caption;
      g.message_id = Math.min(g.message_id, m.message_id);
      byGroup.set(m.media_group_id, g);
    } else {
      singles.push({ ...base, media_group: 'single-' + m.message_id, items: [item] });
    }
  }
  return [...byGroup.values(), ...singles];
}

function createBot(token, deps) {
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
  return {
    async getMe() {
      const r = await deps.httpPostJson(api('getMe'), {});
      const j = JSON.parse(r.body || '{}');
      return j.result || {};
    },
    async getUpdates(offset) {
      const r = await deps.httpPostJson(api('getUpdates'), { offset, timeout: 25, allowed_updates: ['message'] }, 30000);
      const j = JSON.parse(r.body || '{}');
      return j.result || [];
    },
    async getFileUrl(fileId) {
      const r = await deps.httpPostJson(api('getFile'), { file_id: fileId });
      const j = JSON.parse(r.body || '{}');
      if (!j.ok) throw new Error('getFile 失败: ' + r.body);
      return `https://api.telegram.org/file/bot${token}/${j.result.file_path}`;
    },
    async sendMessage(chatId, text) {
      return deps.httpPostJson(api('sendMessage'), { chat_id: chatId, text });
    },
    async sendVideo(chatId, fileUrlOrPath, caption) {
      // 保留：URL 拉取方式。已知问题——Telegram 拉 URL 前会先发 HEAD，若目标路由只处理 GET
      // 会被判定"非视频网页内容"而拒发，回传成品改走 sendVideoFile（见下）；此方法留给其他调用方使用。
      return deps.httpPostJson(api('sendVideo'), { chat_id: chatId, video: fileUrlOrPath, caption: caption || '' });
    },
    // 直接把文件字节以 multipart/form-data 上传给 Telegram，绕开"Telegram 先 HEAD 探测 URL"的坑。
    async sendVideoFile(chatId, filePath, caption) {
      const fs = require('fs');
      const path = require('path');
      const buffer = fs.readFileSync(filePath);
      return deps.httpPostMultipart(
        api('sendVideo'),
        { chat_id: String(chatId), caption: caption || '', supports_streaming: 'true' },
        { name: 'video', filename: path.basename(filePath), contentType: 'video/mp4', buffer }
      );
    },
  };
}

module.exports = { groupUpdates, createBot };
