const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createDb } = require('../lib/db');

const p = path.join(os.tmpdir(), 'jj-db-' + Date.now() + '.sqlite');
const db = createDb(p);

const j = db.create({ tg_chat_id: 'c', media: [{ type: 'image', path: '/a.jpg' }], tags: ['x'], mode: 'manual' });
assert.ok(j.id);
assert.strictEqual(j.status, 'downloading');
const got = db.get(j.id);
assert.strictEqual(got.tg_chat_id, 'c');
assert.deepStrictEqual(got.media, [{ type: 'image', path: '/a.jpg' }]); // JSON 列已解析回对象
assert.deepStrictEqual(got.tags, ['x']);

db.update(j.id, { status: 'rendering', edit_spec: { aspect: 'auto', clips: [] } });
assert.strictEqual(db.get(j.id).status, 'rendering');
assert.deepStrictEqual(db.get(j.id).edit_spec, { aspect: 'auto', clips: [] });
assert.strictEqual(db.listByStatus('rendering').length, 1);

// source：未传时默认 'telegram'，传了则原样落库/读回
assert.strictEqual(j.source, 'telegram');
const jw = db.create({ media: [], tags: [], mode: 'manual', source: 'web' });
assert.strictEqual(jw.source, 'web');
assert.strictEqual(db.get(jw.id).source, 'web');

// listAll：返回全部任务，按 id 降序（最新在前）
const all = db.listAll();
assert.ok(Array.isArray(all));
assert.strictEqual(all[0].id, jw.id); // 最后插入的 id 最大，排在最前
assert.ok(all.some((r) => r.id === j.id));

// 持久化：新实例能读回
const db2 = createDb(p);
assert.strictEqual(db2.get(j.id).status, 'rendering');

// claimNext 原子迁移状态
const claimed = db2.claimNext('rendering', 'processing');
assert.strictEqual(claimed.id, j.id);
assert.strictEqual(db2.get(j.id).status, 'processing');
assert.strictEqual(db2.claimNext('rendering', 'processing'), null);

// remove：删除后 get 返回 null，重复删除返回 false
const jr = db.create({ media: [], tags: [], mode: 'manual' });
assert.strictEqual(db.remove(jr.id), true);
assert.strictEqual(db.get(jr.id), null);
assert.strictEqual(db.remove(jr.id), false);

fs.unlinkSync(p);
console.log('DB_OK');
