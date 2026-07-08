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

// 持久化：新实例能读回
const db2 = createDb(p);
assert.strictEqual(db2.get(j.id).status, 'rendering');

// claimNext 原子迁移状态
const claimed = db2.claimNext('rendering', 'processing');
assert.strictEqual(claimed.id, j.id);
assert.strictEqual(db2.get(j.id).status, 'processing');
assert.strictEqual(db2.claimNext('rendering', 'processing'), null);

fs.unlinkSync(p);
console.log('DB_OK');
