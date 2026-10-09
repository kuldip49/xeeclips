import { postAiServiceJson, type AiServiceResponse } from '../processing/ai-service-http';
import { BadGatewayException, Injectable } from '@nestjs/common';
import type { EditAsset, Prisma } from '@prisma/client';
import { StorageService } from '../storage/storage.service';
import { editAssetStorageLocation } from './edit-asset-storage';

const asJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class EditModeAnalysisService {
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  private readonly timeoutMs = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? '1800000');

  constructor(private readonly storage: StorageService) {}

  private async post(path: string, body: Record<string, unknown>) {
    let response: AiServiceResponse;
    try {
      // Not fetch: its hidden 300 s headers timeout would cut off a long source's analysis.
      response = await postAiServiceJson(`${this.aiServiceUrl}${path}`, body, this.timeoutMs);
    } catch (error) {
      throw new BadGatewayException(`${path} is unavailable: ${
        error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new BadGatewayException(`${path} failed (${response.status}): ${
        (await response.text()).slice(0, 500)}`);
    }
    return response.json() as Promise<unknown>;
  }

  async analyze(asset: EditAsset) {
    const location = editAssetStorageLocation(asset);
    await this.storage.statObject(location.bucket, location.objectKey).catch(() => {
      throw new BadGatewayException('The EditMode source object is missing from storage');
    });

    const transcript = await this.post('/transcriptions', {
      bucket: location.bucket,
      object_key: location.objectKey,
      task: 'transcribe'
    });
    const rawAnalysis = await this.post('/edit-analysis', {
      bucket: location.bucket,
      object_key: location.objectKey,
      fps: Number(process.env.EDIT_ANALYSIS_FPS) || 4
    });
    const record = rawAnalysis && typeof rawAnalysis === 'object'
      ? rawAnalysis as Record<string, unknown> : {};
    const frames = Array.isArray(record.frames) ? record.frames : [];
    const shotBoundaries = Array.isArray(record.shot_boundaries) ? record.shot_boundaries : [];
    let faceDetections = 0;
    let mouthActivitySamples = 0;
    let ocrRegionCount = 0;
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue;
      const item = frame as Record<string, unknown>;
      const faces = Array.isArray(item.faces) ? item.faces : [];
      faceDetections += faces.length;
      mouthActivitySamples += faces.filter((face) => face && typeof face === 'object' &&
        Number((face as Record<string, unknown>).mouth_activity) > 0).length;
      ocrRegionCount += Array.isArray(item.text_boxes) ? item.text_boxes.length : 0;
    }
    const analysis = {
      source: 'DENSE',
      frames,
      shotBoundaries,
      ocrText: typeof record.ocr_text === 'string' ? record.ocr_text : '',
      summary: {
        sampledFrameCount: frames.length,
        faceDetections,
        mouthActivitySamples,
        shotCount: frames.length > 0 ? shotBoundaries.length + 1 : 0,
        ocrRegionCount
      }
    };
    return { transcript: asJson(transcript), analysis: asJson(analysis) };
  }
}
