function parseCaption(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const tags = [];
  const seen = new Set();
  for (const m of raw.matchAll(/#([^\s#]+)/g)) {
    const t = m[1];
    if (!seen.has(t)) { seen.add(t); tags.push(t); }
  }
  const lines = raw.split('\n');
  const title = (lines[0] || '').trim();
  const descLines = lines.slice(1)
    .map((l) => l.replace(/#[^\s#]+/g, '').trim()) // 去掉行内标签
    .filter((l) => l !== '');
  return { title, description: descLines.join('\n'), tags };
}

module.exports = { parseCaption };
