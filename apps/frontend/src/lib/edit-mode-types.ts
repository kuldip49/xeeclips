export type EditProjectStatus = 'DRAFT' | 'READY' | 'EXPORTING' | 'COMPLETED' | 'FAILED';
export type EditAssetRole = 'SOURCE' | 'OVERLAY' | 'AUDIO' | 'IMAGE' | 'LOGO' | 'EXPORT';
export type EditElementType = 'VIDEO' | 'AUDIO' | 'TEXT' | 'SUBTITLE' | 'IMAGE' | 'EFFECT';

export type EditAnalysisSummary = {
  sampledFrameCount: number;
  faceDetections: number;
  mouthActivitySamples: number;
  shotCount: number;
  ocrRegionCount: number;
};

export type EditAsset = {
  id: string;
  editProjectId: string;
  sourceVideoId?: string | null;
  role: EditAssetRole;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  metadata: Record<string, unknown>;
  transcript?: Record<string, unknown> | null;
  analysis?: {
    source?: string;
    summary?: EditAnalysisSummary;
    shotBoundaries?: number[];
    ocrText?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type EditElement = {
  id: string;
  editProjectId: string;
  assetId?: string | null;
  type: EditElementType;
  track: number;
  position: number;
  startTime: number;
  duration: number;
  trimStart: number;
  trimEnd?: number | null;
  properties: Record<string, unknown>;
};

/** Visual coordinates are normalized to the preview canvas (0..1), from its top-left corner. */
export type VisualElementProperties = {
  x: number; y: number; width: number; height: number; scale?: number; rotation: number; opacity: number;
  zIndex: number; anchor: 'top-left'; locked: boolean; role?: 'IMAGE' | 'LOGO';
  content?: string; fontSize?: number; fontWeight?: number; fontFamily?: string;
  textAlign?: 'left' | 'center' | 'right'; color?: string; backgroundColor?: string;
};

/** Audio volume is normalized: 0 is silent and 1 is the asset's original level. */
export type AudioElementProperties = {
  volume: number; muted: boolean; fadeInSec: number; fadeOutSec: number;
  duckUnderSpeech?: boolean; duckLevel?: number; attackMs?: number; releaseMs?: number;
};

export type EditProject = {
  id: string;
  name: string;
  sourceProjectId?: string | null;
  status: EditProjectStatus;
  settings: Record<string, unknown>;
  revision: number;
  assets: EditAsset[];
  elements?: EditElement[];
  _count?: { elements: number; history: number };
  createdAt: string;
  updatedAt: string;
};

export type EditHistory = {
  id: string;
  editProjectId: string;
  revision: number;
  actor: 'USER' | 'PRESET' | 'ASSISTANT' | 'SYSTEM';
  action: string;
  command?: Record<string, unknown> | null;
  beforeState?: Record<string, unknown> | null;
  afterState: Record<string, unknown>;
  createdAt: string;
};

export type SourceVideoOption = {
  id: string;
  originalName: string;
  project?: { id: string; name: string };
};
