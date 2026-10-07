import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { compare, hash } from 'bcryptjs';

const longPasswordPrefix = '$xeeclip-bcrypt-hmac-sha384-v1$';
const validLength = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 128;

export function validatePassword(value: unknown): asserts value is string {
  if (!validLength(value)) throw new BadRequestException('Use a password of 8 to 128 characters.');
}

export function assertPasswordConfiguration() {
  if (Buffer.byteLength(process.env.PASSWORD_HASH_PEPPER ?? '', 'utf8') < 32) throw new Error('PASSWORD_HASH_PEPPER must contain at least 32 bytes. Keep it stable and outside the database.');
}

function prepareLongPassword(value: string) {
  assertPasswordConfiguration();
  // Bcrypt silently truncates beyond 72 bytes. OWASP's HMAC/base64 preparation
  // preserves the full password while keeping the bcrypt input below that limit.
  return createHmac('sha384', process.env.PASSWORD_HASH_PEPPER!).update(value, 'utf8').digest('base64');
}

export async function hashPassword(value: unknown) {
  validatePassword(value);
  if (Buffer.byteLength(value, 'utf8') <= 72) return hash(value, 12);
  return longPasswordPrefix + await hash(prepareLongPassword(value), 12);
}

export async function verifyPassword(value: unknown, storedHash: string) {
  const valid = validLength(value);
  if (storedHash.startsWith(longPasswordPrefix)) {
    return await compare(valid ? prepareLongPassword(value) : '', storedHash.slice(longPasswordPrefix.length)) && valid;
  }
  // Existing direct bcrypt hashes remain valid, without accepting truncated tails.
  const supported = valid && Buffer.byteLength(value, 'utf8') <= 72;
  return await compare(supported ? value : '', storedHash) && supported;
}
