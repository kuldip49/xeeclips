const { PrismaClient } = require('@prisma/client');
const { buildTranscriptChunks } = require('../dist/modules/processing/transcript-chunks');
const prisma = new PrismaClient();

async function main() {
  const transcripts = await prisma.transcript.findMany({ select: { videoId: true } });
  let count = 0;
  for (const { videoId } of transcripts) {
    count += await prisma.$transaction(async (tx) => {
      const latest = await tx.processingJob.findFirst({ where: { videoId }, orderBy: { createdAt: 'desc' } });
      if (latest?.status !== 'COMPLETED') return 0;
      const segments = await tx.transcriptSegment.findMany({ where: { transcript: { videoId } }, orderBy: { position: 'asc' } });
      const chunks = buildTranscriptChunks(videoId, segments);
      await tx.transcriptChunk.deleteMany({ where: { videoId } });
      if (chunks.length) await tx.transcriptChunk.createMany({ data: chunks });
      return chunks.length;
    });
  }
  console.log(`Stored ${count} chunks from completed transcripts.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
