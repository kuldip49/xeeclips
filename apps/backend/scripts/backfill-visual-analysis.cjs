const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
const refresh = process.argv.includes('--refresh');

function parseResult(value, expectedPositions) {
  if (!Array.isArray(value)) throw new Error('Invalid visual analysis response');
  const byPosition = new Map(value.map((item) => [item.position, item]));
  if (
    byPosition.size !== expectedPositions.length ||
    expectedPositions.some((position) => !byPosition.has(position))
  ) {
    throw new Error('Visual analysis response did not include every chunk');
  }
  return byPosition;
}

async function main() {
  const videos = await prisma.video.findMany({
    where: {
      chunks: refresh ? { some: {} } : { some: { visualAnalysis: null } },
      processingJobs: { none: { status: { in: ['PENDING', 'PROCESSING'] } } }
    },
    select: {
      id: true,
      bucket: true,
      objectKey: true,
      chunks: {
        orderBy: { position: 'asc' },
        select: { id: true, position: true, startTime: true, endTime: true }
      }
    }
  });

  let recordCount = 0;
  for (const video of videos) {
    const response = await fetch(`${aiServiceUrl}/visual-analysis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bucket: video.bucket,
        object_key: video.objectKey,
        chunks: video.chunks.map((chunk) => ({
          position: chunk.position,
          start: chunk.startTime,
          end: chunk.endTime
        }))
      })
    });
    if (!response.ok) {
      throw new Error(
        `Visual analysis failed for ${video.id} (${response.status}): ${await response.text()}`
      );
    }
    const analyses = parseResult(
      await response.json(),
      video.chunks.map((chunk) => chunk.position)
    );

    await prisma.$transaction(
      video.chunks.map((chunk) => {
        const visual = analyses.get(chunk.position);
        const data = {
          shotBoundaries: visual.shot_boundaries,
          sceneChangeCount: visual.scene_change_count,
          averageMotion: visual.average_motion,
          faceCount: visual.face_count,
          largestFaceRatio: visual.largest_face_ratio,
          brightness: visual.brightness,
          contrast: visual.contrast,
          colorfulness: visual.colorfulness,
          ocrText: visual.ocr_text,
          subtitleDetected: visual.subtitle_detected
        };
        return prisma.visualAnalysis.upsert({
          where: { chunkId: chunk.id },
          create: { chunkId: chunk.id, ...data },
          update: data
        });
      })
    );
    recordCount += video.chunks.length;
    console.log(`Analyzed ${video.chunks.length} chunks for video ${video.id}`);
  }

  console.log(`Visual analysis backfill complete: ${recordCount} records`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
