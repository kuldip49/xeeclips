// Run on the backend host after backup and explicit owner confirmation.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const admin = await prisma.user.findUnique({ where: { email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase() } });
  if (!admin || admin.role !== 'ADMIN') throw new Error('Configured owner account does not exist.');
  const models = ['project', 'editProject', 'referenceAsset', 'savedStyle', 'editTemplate'];
  const counts = Object.fromEntries(await Promise.all(models.map(async m => [m, await prisma[m].count({ where: { userId: null } })])));
  console.log('Unowned root records:', JSON.stringify(counts));
  if (!process.argv.includes('--apply')) return;
  const expectedArg = process.argv.find(v => v.startsWith('--expected='));
  if (!expectedArg || JSON.stringify(JSON.parse(expectedArg.slice(11))) !== JSON.stringify(counts)) throw new Error('Explicit exact counts are required. Run a dry audit and pass --expected=<reported JSON>.');
  await prisma.$transaction(async tx => {
    for (const m of models) {
      const result = await tx[m].updateMany({ where: { userId: null }, data: { userId: admin.id, ...(['savedStyle', 'editTemplate'].includes(m) ? { ownerScope: admin.id } : {}) } });
      if (result.count !== counts[m]) throw new Error('Legacy records changed; audit again before attribution.');
    }
    await tx.auditLog.create({ data: { adminId: admin.id, targetUserId: admin.id, action: 'LEGACY_OWNERSHIP_CLAIM', before: counts, after: { ownerId: admin.id, counts }, reason: 'Owner explicitly confirmed all historical content after exact count audit.' } });
  });
  console.log('Ownership assigned; all media and history preserved.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
