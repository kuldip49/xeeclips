import { Injectable } from '@nestjs/common';
import { VideosService } from './videos.service';
import { DiskUploadSessionStore } from './disk-upload-session-store';

/** The existing long-video ingestion keeps its original finalizer. */
@Injectable()
export class VideoUploadSessionService extends DiskUploadSessionStore {
  constructor(videos: VideosService) {
    super((manifest, file) => videos.createFromUpload(manifest.projectId, file,
      manifest.aiMode, manifest.processingType, manifest.aspectRatio, manifest.targetPlatform,
      undefined, manifest.generationRequest));
  }
}
