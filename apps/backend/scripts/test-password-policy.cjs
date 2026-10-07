const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { hash, getRounds } = require('bcryptjs');
const { validatePassword, hashPassword, verifyPassword } = require('../dist/modules/auth/password');
process.env.PASSWORD_HASH_PEPPER = randomBytes(48).toString('base64url');
async function main() {
  for (const value of [undefined, null, 123, 'a'.repeat(7), 'a'.repeat(129)]) assert.throws(() => validatePassword(value));
  for (const value of ['a'.repeat(8), 'b'.repeat(11), 'c'.repeat(72), 'd'.repeat(73), 'e'.repeat(128), '界'.repeat(128)]) {
    validatePassword(value); const encoded = await hashPassword(value);
    assert.equal(await verifyPassword(value, encoded), true);
    assert.equal(await verifyPassword(value.slice(0, -1) + 'x', encoded), false);
    assert.equal(await verifyPassword('z'.repeat(129), encoded), false);
    assert.equal(await verifyPassword('z'.repeat(7), encoded), false);
    assert.equal(getRounds(encoded.slice(encoded.indexOf('$2'))), 12);
  }
  const first = 'p'.repeat(72) + 'tail-A', second = 'p'.repeat(72) + 'tail-B';
  assert.equal(await verifyPassword(second, await hashPassword(first)), false);
  const legacy = await hash('legacy-password', 12);
  assert.equal(await verifyPassword('legacy-password', legacy), true);
  assert.equal(await verifyPassword('legacy-password-extra', legacy), false);
  const longHash = await hashPassword('r'.repeat(128));
  process.env.PASSWORD_HASH_PEPPER = randomBytes(48).toString('base64url');
  assert.equal(await verifyPassword('r'.repeat(128), longHash), false);
  console.log('PASS 8/11/72/73/128-character passwords, Unicode, 7/129 rejection, full tail verification, cost-12 bcrypt, legacy compatibility and pepper separation.');
}
main().catch(() => { console.error('Password policy test failed.'); process.exitCode = 1; });
