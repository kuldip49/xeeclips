import { AiProcessingMode } from './ai-processing-mode';

export const VIDEO_PROCESSING_QUEUE = "video-processing";
export const PROCESS_VIDEO_JOB = "process-video";

export type ProcessVideoJobData = {
  processingJobId: string;
  videoId: string;
  aiMode?: AiProcessingMode;
};
