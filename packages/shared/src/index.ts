export type ServiceHealth = {
  service: string;
  status: "ok";
  timestamp: string;
};

export type ProcessingStage =
  | "uploaded"
  | "queued"
  | "extracting_audio"
  | "ready"
  | "failed";

export type ProjectDto = {
  id: string;
  name: string;
  description?: string | null;
  videos: VideoDto[];
  createdAt: string;
  updatedAt: string;
};

export type VideoDto = {
  id: string;
  projectId: string;
  originalName: string;
  objectKey: string;
  bucket: string;
  mimeType: string;
  sizeBytes: number;
  duration?: number | null;
  fps?: number | null;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
  bitrate?: number | null;
  audioObjectKey?: string | null;
  audioBucket?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type { ReframeBox, ReframeRegion, ReframeAnalysis, ReframePlan, ReframeSession } from './quick-reframe';
