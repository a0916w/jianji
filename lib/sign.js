const crypto = require('crypto');

function secret() {
  const s = process.env.SIGN_SECRET || '';
  if (!s) throw new Error('SIGN_SECRET 未配置');
  return s;
}
function sign(id) {
  return crypto.createHmac('sha256', secret()).update(String(id)).digest('hex');
}
function verify(id, sig) {
  const expected = sign(id);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { sign, verify };
