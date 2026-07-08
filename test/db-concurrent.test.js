// test/db-concurrent.test.js —— 并发领取回归测试：证明 claimNext 在并发/多连接场景下
// 既不会重复领取(no double-claim)，也不会抛出未捕获异常(no crash / SQLITE_BUSY)。
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createDb } = require('../lib/db');

const p = path.join(os.tmpdir(), 'jj-db-concurrent-' + Date.now() + '.sqlite');

// ---- Part A：单连接，紧凑循环 claim 到耗尽 ----
{
  const db = createDb(p);
  const N = 20;
  const seeded = [];
  for (let i = 0; i < N; i++) {
    const j = db.create({ tg_chat_id: 'c', media: [], tags: [], mode: 'manual', status: 'rendering' });
    seeded.push(j.id);
  }

  const claimedIds = new Set();
  let errorThrown = null;
  try {
    let claimed;
    while ((claimed = db.claimNext('rendering', 'processing')) !== null) {
      assert.ok(!claimedIds.has(claimed.id), 'Part A: duplicate claim of job ' + claimed.id);
      claimedIds.add(claimed.id);
    }
  } catch (e) {
    errorThrown = e;
  }

  assert.strictEqual(errorThrown, null, 'Part A: claimNext threw: ' + (errorThrown && errorThrown.stack));
  assert.strictEqual(claimedIds.size, N, `Part A: expected ${N} claimed jobs, got ${claimedIds.size}`);
  assert.strictEqual(db.claimNext('rendering', 'processing'), null, 'Part A: pool should be exhausted');
}

// ---- Part B：两个独立连接(同一文件)交替 claim，验证无重复/无遗漏/不崩溃 ----
{
  const db1 = createDb(p);
  const db2 = createDb(p);
  const N = 30;
  const seeded = new Set();
  for (let i = 0; i < N; i++) {
    const j = db1.create({ tg_chat_id: 'c2', media: [], tags: [], mode: 'manual', status: 'rendering2' });
    seeded.add(j.id);
  }

  const claimed1 = [];
  const claimed2 = [];
  let errorThrown = null;
  try {
    let doneA = false, doneB = false;
    // 交替从两个连接各领一次，模拟多进程轮询同一状态队列
    while (!(doneA && doneB)) {
      if (!doneA) {
        const r = db1.claimNext('rendering2', 'processing2');
        if (r) claimed1.push(r.id); else doneA = true;
      }
      if (!doneB) {
        const r = db2.claimNext('rendering2', 'processing2');
        if (r) claimed2.push(r.id); else doneB = true;
      }
    }
  } catch (e) {
    errorThrown = e;
  }

  assert.strictEqual(errorThrown, null, 'Part B: claimNext threw under interleaved connections: ' + (errorThrown && errorThrown.stack));

  const allClaimed = claimed1.concat(claimed2);
  const uniqueClaimed = new Set(allClaimed);
  assert.strictEqual(uniqueClaimed.size, allClaimed.length, 'Part B: duplicate claim across connections detected');
  assert.strictEqual(uniqueClaimed.size, N, `Part B: expected union of claims to equal seeded count ${N}, got ${uniqueClaimed.size}`);
  for (const id of uniqueClaimed) assert.ok(seeded.has(id), 'Part B: claimed id not in seeded set: ' + id);
  for (const id of seeded) assert.ok(uniqueClaimed.has(id), 'Part B: seeded id never claimed: ' + id);
}

fs.unlinkSync(p);
console.log('DB_CONCURRENT_OK');
