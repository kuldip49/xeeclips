import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Readable } from 'stream';
import { parseAutoGeneration } from './auto-generation';
import { VideosService } from './videos.service';

const CHUNK_BYTES = 20 * 1024 * 1024;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Manifest = {
  id: string; projectId: string; name: string; mimeType: string; size: number;
  chunks: number; createdAt: string; aiMode?: unknown; processingType?: unknown;
  aspectRatio?: unknown; targetPlatform?: unknown;
  generationRequest?: ReturnType<typeof parseAutoGeneration>;
};

@Injectable()
export class VideoUploadSessionService {
  private readonly root = process.env.UPLOAD_STAGING_DIR || join(tmpdir(), 'ai-content-upload-staging');

  constructor(private readonly videos: VideosService) {}

  private directory(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid upload session ID');
    return join(this.root, id);
  }

  private async manifest(id: string): Promise<Manifest> {
    try {
      return JSON.parse(await readFile(join(this.directory(id), 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      throw new NotFoundException('Upload session not found');
    }
  }

  async create(projectId: string, body: Record<string, unknown>) {
    const size = body.size;
    const name = body.name;
    const mimeType = body.mimeType;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) {
      throw new BadRequestException('Video size must be between 1 byte and 4 GiB');
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 255 ||
        typeof mimeType !== 'string' || !mimeType.startsWith('video/') || mimeType.length > 100) {
      throw new BadRequestException('A named video file is required');
    }
    const id = randomUUID();
    const manifest: Manifest = {
      id, projectId, name: basename(name), mimeType, size,
      chunks: Math.ceil(size / CHUNK_BYTES), createdAt: new Date().toISOString(),
      aiMode: body.aiMode, processingType: body.processingType,
      aspectRatio: body.aspectRatio, targetPlatform: body.targetPlatform,
      generationRequest: parseAutoGeneration(body.generationRequest)
    };
    await mkdir(this.root, { recursive: true });
    await mkdir(this.directory(id));
    await writeFile(join(this.directory(id), 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
    return { id, chunkBytes: CHUNK_BYTES, chunks: manifest.chunks };
  }

  async writeChunk(id: string, indexValue: string, source: Readable) {
    const manifest = await this.manifest(id);
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0 || index >= manifest.chunks) {
      throw new BadRequestException('Invalid chunk index');
    }
    const expected = Math.min(CHUNK_BYTES, manifest.size - index * CHUNK_BYTES);
    const directory = this.directory(id);
    const part = join(directory, `${index}.part`);
    const existing = await stat(part).catch(() => null);
    if (existing) {
      if (existing.size !== expected) throw new ConflictException('Stored chunk has the wrong size');
      return { index, size: expected };
    }
    const temporary = join(directory, `${index}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx');
    let received = 0;
    try {
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        received += chunk.length;
        if (received > expected) throw new BadRequestException('Chunk exceeds its expected size');
        await file.writeFile(chunk);
      }
      if (received !== expected) throw new BadRequestException('Incomplete upload chunk');
    } catch (error) {
      await file.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await file.close();
    await rename(temporary, part);
    return { index, size: expected };
  }

  async complete(id: string) {
    const manifest = await this.manifest(id);
    const directory = this.directory(id);
    const resultPath = join(directory, 'result.json');
    const existingResult = await readFile(resultPath, 'utf8').catch(() => null);
    if (existingResult) return JSON.parse(existingResult) as unknown;
    const lock = join(directory, '.finalizing');
    try { await mkdir(lock); } catch { throw new ConflictException('Upload is already finalizing'); }
    const assembled = join(directory, 'assembled.video');
    try {
      for (let index = 0; index < manifest.chunks; index++) {
        const part = await stat(join(directory, `${index}.part`)).catch(() => null);
        const expected = Math.min(CHUNK_BYTES, manifest.size - index * CHUNK_BYTES);
        if (!part || part.size !== expected) {
          throw new ConflictException(`Upload chunk ${index} is missing or incomplete`);
        }
      }
      const output = await open(assembled, 'w');
      try {
        for (let index = 0; index < manifest.chunks; index++) {
          for await (const chunk of createReadStream(join(directory, `${index}.part`))) {
            await output.writeFile(chunk as Buffer);
          }
        }
      } finally { await output.close(); }
      const file = { path: assembled, originalname: manifest.name, mimetype: manifest.mimeType,
        size: manifest.size } as Express.Multer.File;
      const result = await this.videos.createFromUpload(manifest.projectId, file,
        manifest.aiMode, manifest.processingType, manifest.aspectRatio, manifest.targetPlatform,
        undefined, manifest.generationRequest);
      await writeFile(resultPath, JSON.stringify(result), { flag: 'wx' });
      for (let index = 0; index < manifest.chunks; index++) {
        await rm(join(directory, `${index}.part`), { force: true });
      }
      return result;
    } finally {
      await rm(assembled, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
