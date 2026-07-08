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
      // Phase 1：成品有公开 URL 时用 URL 发；否则回退发下载链接文本（见 worker）。
      return deps.httpPostJson(api('sendVideo'), { chat_id: chatId, video: fileUrlOrPath, caption: caption || '' });
    },
  };
}

module.exports = { groupUpdates, createBot };
