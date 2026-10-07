/**
 * The left rail's tool categories.
 *
 * A category is listed here only once something behind it can actually change
 * the project. `pending` marks a category whose backing commands do not exist
 * yet: the rail shows it greyed with the reason, rather than opening a panel of
 * controls that cannot edit anything. Nothing in EditMode should ever offer a
 * control that silently does nothing.
 */
export type EditToolId = 'MEDIA' | 'TEMPLATES' | 'AUDIO' | 'TEXT' | 'CAPTIONS' | 'OVERLAY'
  | 'CROP' | 'EFFECTS' | 'FILTERS' | 'ADJUST' | 'HOOKS' | 'POST_COPY';

export type EditToolDefinition = {
  id: EditToolId;
  label: string;
  /** Absent once the category is live. Shown as the disabled reason. */
  pending?: string;
  /** Offered only inside a Quick Reframe project (its suggested hooks and caption decision). */
  quickReframeOnly?: boolean;
};

export const EDIT_TOOLS: EditToolDefinition[] = [
  { id: 'HOOKS', label: 'Hooks' },
  { id: 'POST_COPY', label: 'Caption & Hashtags', quickReframeOnly: true },
  { id: 'MEDIA', label: 'Media' },
  { id: 'TEMPLATES', label: 'Templates' },
  { id: 'AUDIO', label: 'Audio' },
  { id: 'TEXT', label: 'Text' },
  { id: 'CAPTIONS', label: 'Video Captions' },
  { id: 'CROP', label: 'Crop' },
  { id: 'OVERLAY', label: 'Overlay' },
  { id: 'EFFECTS', label: 'Effects', pending: 'Transitions and effects are not implemented yet. Crop, rotation, flip, scale and speed are in the Inspector.' },
  { id: 'FILTERS', label: 'Filters' },
  { id: 'ADJUST', label: 'Adjust' }
];

/** The rail for a project: Quick Reframe projects add their Hooks tool, every other project is unchanged. */
export const toolsFor = (quickReframe: boolean) => EDIT_TOOLS.filter((tool) => quickReframe || !tool.quickReframeOnly);

export const editTool = (id: EditToolId) =>
  EDIT_TOOLS.find((tool) => tool.id === id) ?? EDIT_TOOLS[0];

export const isToolAvailable = (id: EditToolId) => !editTool(id).pending;
