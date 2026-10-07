// Local operator recovery. Read a new password from stdin, never command arguments.
const { PrismaClient } = require('@prisma/client');
const { hashPassword, validatePassword } = require('../dist/modules/auth/password');
const prisma = new PrismaClient();
async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  let password = ''; for await (const chunk of process.stdin) password += chunk;
  password = password.replace(/\r?\n$/, '');
  validatePassword(password);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async tx => { await tx.user.update({ where: { id: user.id }, data: { passwordHash } }); await tx.session.deleteMany({ where: { userId: user.id } }); });
  console.log('Password changed; previous sessions invalidated.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
