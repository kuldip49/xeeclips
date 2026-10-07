// Existing media unit tests use an in-memory Prisma stand-in. Model an unlimited
// owner and interactive transactions; real credit correctness uses PostgreSQL tests.
module.exports = function usageFixture(prisma) {
  const reservations = new Map();
  prisma.project = { findUniqueOrThrow: async () => ({ userId: 'fixture-owner' }) };
  prisma.user = { findUniqueOrThrow: async () => ({ id: 'fixture-owner', role: 'ADMIN', status: 'ACTIVE' }), updateMany: async () => ({ count: 1 }), update: async () => ({}) };
  prisma.creditReservation = {
    findUnique: async ({ where }) => reservations.get(where.jobKey) ?? null,
    create: async ({ data }) => { const r = { ...data, id: data.jobKey, status: 'RESERVED' }; reservations.set(r.jobKey, r); return r; },
    updateMany: async ({ where, data }) => { const r = [...reservations.values()].find(v => v.id === where.id && v.status === where.status); if (!r) return { count: 0 }; Object.assign(r, data); return { count: 1 }; }
  };
  prisma.creditTransaction = { create: async ({ data }) => data };
  if (prisma.generatedClip) prisma.generatedClip.count = async () => 1;
  if (!prisma.processingJob.update) prisma.processingJob.update = async ({ data }) => { await prisma.processingJob.updateMany({ data }); return prisma.processingJob.findUnique({}); };
  prisma.$transaction = async input => typeof input === 'function' ? input(prisma) : Promise.all(input);
  return prisma;
};
