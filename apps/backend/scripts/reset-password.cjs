// Local operator recovery. Read a new password from stdin, never command arguments.
const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');
const prisma = new PrismaClient();
async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  let password = ''; for await (const chunk of process.stdin) password += chunk;
  password = password.replace(/\r?\n$/, '');
  if (password.length < 12 || Buffer.byteLength(password) > 72) throw new Error('Password must be 12+ characters and at most 72 UTF-8 bytes.');
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.$transaction(async tx => { await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hash(password, 12) } }); await tx.session.deleteMany({ where: { userId: user.id } }); });
  console.log('Password changed; previous sessions invalidated.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
