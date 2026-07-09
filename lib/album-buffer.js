// lib/album-buffer.js —— 相册跨 getUpdates 轮询缓冲：Telegram 把一个相册拆成多条 message 且常常
// 跨多次 getUpdates 返回，这里按 media_group_id 在轮询之间累积素材，直到短暂静默(防抖)后才判定"到齐"。
// 纯函数、无副作用（不读时钟/不发请求），nowMs 一律由调用方传入，方便测试用假时间戳精确控制。

// 把一批 groupUpdates() 产出的 batch 合并进跨轮询缓冲区 pending（Map: media_group -> entry）。
// 相同 media_group 再次出现时：追加素材（按 file_id 去重）、message_id 取更小值、caption 为空时才采用新值。
function mergeIntoPending(pending, batches, nowMs) {
  for (const batch of batches) {
    const key = batch.media_group;
    let entry = pending.get(key);
    if (entry) {
      const seen = new Set(entry.items.map((it) => it.file_id));
      for (const it of batch.items) {
        if (!seen.has(it.file_id)) {
          entry.items.push(it);
          seen.add(it.file_id);
        }
      }
      entry.message_id = Math.min(entry.message_id, batch.message_id);
      if (!entry.caption && batch.caption) entry.caption = batch.caption;
    } else {
      entry = {
        chat_id: batch.chat_id,
        message_id: batch.message_id,
        media_group: batch.media_group,
        items: [...batch.items],
        caption: batch.caption || '',
      };
      pending.set(key, entry);
    }
    entry.lastTs = nowMs;
    entry.isSingle = batch.media_group.startsWith('single-');
  }
  return pending;
}

// 挑出"已到齐"的批次并从 pending 里摘除：非相册（isSingle）立即就绪；
// 相册需自 lastTs 起静默满 debounceMs（debounceMs<=0 时天然立即就绪，供一次性轮询场景直接落地）。
function takeReady(pending, nowMs, debounceMs) {
  const ready = [];
  for (const [key, entry] of pending) {
    if (entry.isSingle || nowMs - entry.lastTs >= debounceMs) {
      ready.push({
        chat_id: entry.chat_id,
        message_id: entry.message_id,
        media_group: entry.media_group,
        items: entry.items,
        caption: entry.caption,
      });
      pending.delete(key);
    }
  }
  return ready;
}

module.exports = { mergeIntoPending, takeReady };
