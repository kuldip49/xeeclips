import { Injectable } from "@nestjs/common";
import { Client } from "minio";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

@Injectable()
export class StorageService {
  async onModuleInit() {
    await this.ensureBucket();
    // All browser media travels through the session/ownership-protected API.
    await this.client.setBucketPolicy(this.bucket, '');
  }
  private readonly bucket = process.env.MINIO_BUCKET ?? "ai-content-platform";
  private readonly client = new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ROOT_USER ?? "minioadmin",
    secretKey: process.env.MINIO_ROOT_PASSWORD ?? "minioadmin"
  });

  async ensureBucket() {
    const exists = await this.client.bucketExists(this.bucket).catch(() => false);

    if (!exists) {
      await this.client.makeBucket(this.bucket);
    }
  }

  async uploadVideo(input: {
    buffer: Buffer;
    objectKey: string;
    mimeType: string;
  }) {
    return this.uploadBuffer(input);
  }

  async uploadBuffer(input: {
    buffer: Buffer;
    objectKey: string;
    mimeType: string;
  }) {
    await this.ensureBucket();
    await this.client.putObject(
      this.bucket,
      input.objectKey,
      input.buffer,
      input.buffer.length,
      { "Content-Type": input.mimeType }
    );

    return {
      bucket: this.bucket,
      objectKey: input.objectKey
    };
  }

  async uploadFile(input: {
    filePath: string;
    objectKey: string;
    mimeType: string;
  }) {
    await this.ensureBucket();
    await this.client.fPutObject(this.bucket, input.objectKey, input.filePath, {
      "Content-Type": input.mimeType
    });

    return { bucket: this.bucket, objectKey: input.objectKey };
  }

  async downloadToFile(bucket: string, objectKey: string, filePath: string) {
    const source = await this.client.getObject(bucket, objectKey);
    await pipeline(source, createWriteStream(filePath));
  }

  async removeObject(bucket: string, objectKey: string) {
    await this.client.removeObject(bucket, objectKey);
  }

  statObject(bucket: string, objectKey: string) {
    return this.client.statObject(bucket, objectKey);
  }

  getObject(bucket: string, objectKey: string) {
    return this.client.getObject(bucket, objectKey);
  }

  getPartialObject(bucket: string, objectKey: string, offset: number, length: number) {
    return this.client.getPartialObject(bucket, objectKey, offset, length);
  }

  /** A short-lived internal URL FFmpeg can seek over HTTP (no full download). */
  presignedGetUrl(bucket: string, objectKey: string, expirySec = 600) {
    return this.client.presignedGetObject(bucket, objectKey, expirySec);
  }
}
