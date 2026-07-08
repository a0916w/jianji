process.env.SIGN_SECRET = 'test-secret';
const assert = require('node:assert');
const { sign, verify } = require('../lib/sign');

const s = sign('job-1');
assert.strictEqual(typeof s, 'string');
assert.ok(verify('job-1', s));
assert.ok(!verify('job-1', 'deadbeef'));
assert.ok(!verify('job-2', s));
console.log('SIGN_OK');
