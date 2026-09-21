const { PrismaClient } = require('@prisma/client');
const { analyzeTranscriptChunk } = require('../dist/modules/processing/chunk-analysis');
const prisma = new PrismaClient();

async function main() {
  const chunks = await prisma.transcriptChunk.findMany({
    where: { analysis: null },
    select: { id: true, text: true, duration: true }
  });
  if (chunks.length) {
    await prisma.$transaction(chunks.map((chunk) => prisma.chunkAnalysis.create({
      data: { chunkId: chunk.id, ...analyzeTranscriptChunk(chunk) }
    })));
  }
  console.log(`Stored analysis for ${chunks.length} existing chunks.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
