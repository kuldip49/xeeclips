import { z } from "zod";
import { CAPTION_STYLE_PRESETS } from "../edit-mode/edit-mode-text";
import type { McpCategory } from "./mcp-operations.service";
import type { McpScope } from "./mcp-config";
const id = z.uuid(),
  seconds = z.number().finite().min(0).max(10800),
  unit = z.number().finite().min(0).max(1);
const key = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().min(0).max(2147483647);
export const mode = z.enum(["XEEFREE", "XEEPRO"]);
export const style = z.enum(["STYLE_ZERO", "STYLE_ONE", "STYLE_TWO"]);
const campaignPage = {
  offset: z.number().int().min(0).max(1000000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const page = {
  cursor: id.optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
const write = { idempotencyKey: key };
const edit = { ...write, editProjectId: id, expectedRevision: revision };
const selected = { ...edit, elementId: id.optional() };
const media = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EDITOR_ASSET"), assetId: id }).strict(),
  z
    .object({ kind: z.literal("CAMPAIGN_ASSET"), campaignId: id, assetId: id })
    .strict(),
]);
const rect = z
  .object({ x: unit, y: unit, width: unit.min(0.01), height: unit.min(0.01) })
  .strict();
const crop = z
  .object({
    left: unit.max(0.95),
    right: unit.max(0.95),
    top: unit.max(0.95),
    bottom: unit.max(0.95),
  })
  .strict();
const visual = z
  .object({
    exposure: z.number().min(-1).max(1).optional(),
    brightness: z.number().min(-1).max(1).optional(),
    contrast: z.number().min(-1).max(1).optional(),
    saturation: z.number().min(-1).max(1).optional(),
    highlights: z.number().min(-1).max(1).optional(),
    shadows: z.number().min(-1).max(1).optional(),
    temperature: z.number().min(-1).max(1).optional(),
    tint: z.number().min(-1).max(1).optional(),
    sharpness: unit.optional(),
    fade: unit.optional(),
    vignette: unit.optional(),
  })
  .strict();
export type McpTool = {
  name: string;
  description: string;
  scopes: McpScope[];
  category: McpCategory;
  schema: z.ZodObject<any>;
};
const tools: McpTool[] = [];
function tool(
  name: string,
  scope: McpScope | McpScope[],
  category: McpCategory,
  description: string,
  shape: z.ZodRawShape,
) {
  tools.push({
    name: "xeeclip_" + name,
    scopes: Array.isArray(scope) ? scope : [scope],
    category,
    description:
      description +
      (category === "READ"
        ? " Read-only; only your owned resources are accessible."
        : " Mutates your XeeClip state; use a stable idempotencyKey for retries. Changes are visible in XeeClip."),
    schema: z.object(shape).strict(),
  });
}
tool(
  "get_account",
  "xeeclip:account:read",
  "READ",
  "Read your safe XeeClip account summary.",
  {},
);
tool(
  "get_credits",
  "xeeclip:credits:read",
  "READ",
  "Read your current canonical credits; no separate MCP balance.",
  {},
);
tool(
  "list_sources",
  "xeeclip:sources:read",
  "READ",
  "List existing authorized XeeClip sources with pagination.",
  page,
);
tool(
  "get_source",
  "xeeclip:sources:read",
  "READ",
  "Inspect an existing source and whether analysis is ready.",
  { sourceId: id },
);
tool(
  "create_clips",
  ["xeeclip:clips:create", "xeeclip:sources:read"],
  "GENERATION",
  "Start existing clip generation asynchronously. May consume one generation credit. XeeFree makes no cloud calls; busy XeePro never switches modes.",
  {
    ...write,
    sourceId: id,
    mode,
    style,
    clipCount: z.number().int().min(1).max(30),
    instruction: z.string().max(1500).optional(),
  },
);
tool(
  "get_job",
  "xeeclip:clips:read",
  "READ",
  "Poll a canonical generation job. Follow recommendedPollAfterMs; do not retry generation to poll.",
  {
    jobId: z
      .string()
      .min(3)
      .max(160)
      .regex(/^(?:c:[a-f0-9-]{36}:[0-9]{13}|[gr]:[a-f0-9-]{36})$/),
  },
);
tool(
  "list_clips",
  "xeeclip:clips:read",
  "READ",
  "List your clips with pagination and stable source references.",
  { ...page, sourceId: id.optional() },
);
tool(
  "get_clip",
  "xeeclip:clips:read",
  "READ",
  "Read a clip and its canonical editor/result references.",
  { clipId: id },
);
tool(
  "quick_reframe",
  ["xeeclip:reframe:create", "xeeclip:sources:read"],
  "GENERATION",
  "Start Quick Reframe asynchronously from an existing source of at most 180 seconds. Keeps the Result flow; does not force the editor. Canonical generation credit policy applies.",
  { ...write, sourceId: id, mode, style, crop: rect.optional() },
);
tool(
  "get_reframe_result",
  "xeeclip:clips:read",
  "READ",
  "Read Quick Reframe progress or saved Result without triggering editing.",
  { reframeId: id },
);
tool(
  "list_campaigns",
  "xeeclip:campaigns:read",
  "READ",
  "List your campaign workspace.",
  campaignPage,
);
tool(
  "get_campaign",
  "xeeclip:campaigns:read",
  "READ",
  "Read a campaign, current brief, stored assets, sources and current clips.",
  { campaignId: id, ...campaignPage },
);
tool(
  "create_campaign",
  "xeeclip:campaigns:create",
  "EDITOR_WRITE",
  "Create a draft campaign through the existing workspace. Rules require understanding and explicit user confirmation before generation.",
  {
    ...write,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(10000).optional(),
    rules: z.string().max(50000).optional(),
    platforms: z.array(z.string().min(1).max(80)).max(10).default([]),
  },
);
tool(
  "understand_campaign",
  "xeeclip:campaigns:create",
  "EDITOR_WRITE",
  "Structure supplied campaign rules using the selected existing mode. Read get_campaign to review the resulting brief. Does not confirm rules; XeePro requires AI consent and never silently falls back.",
  {
    ...write,
    campaignId: id,
    expectedBriefVersion: z.number().int().min(1).max(2147483647),
    rules: z.string().min(1).max(50000),
    mode,
  },
);
tool(
  "confirm_campaign",
  "xeeclip:campaigns:create",
  "EDITOR_WRITE",
  "Confirm a reviewed campaign brief only after the user explicitly approves its rules. Unknown rules remain subject to review.",
  {
    ...write,
    campaignId: id,
    briefVersion: z.number().int().min(1).max(2147483647),
    userConfirmed: z.literal(true),
    acknowledgeUnresolved: z.boolean().default(false),
  },
);
tool(
  "attach_campaign_source",
  ["xeeclip:campaigns:create", "xeeclip:sources:read"],
  "EDITOR_WRITE",
  "Attach an existing owned source to an owned campaign after the user confirms source rights.",
  { ...write, campaignId: id, sourceId: id, rightsConfirmed: z.literal(true) },
);
tool(
  "generate_campaign_clips",
  "xeeclip:campaigns:generate",
  "GENERATION",
  "Generate clips asynchronously using confirmed campaign rules and stored campaign assets. May consume canonical generation credits; no asset re-upload is needed.",
  {
    ...write,
    campaignId: id,
    campaignSourceIds: z.array(id).min(1).max(10),
    mode,
    style,
    clipCount: z.number().int().min(1).max(20),
    instruction: z.string().max(1500).optional(),
  },
);
tool(
  "get_campaign_clip_compliance",
  "xeeclip:campaigns:read",
  "READ",
  "Read current PASS/WARN/FAIL/UNKNOWN/NOT_APPLICABLE checks; does not claim posting approval.",
  { campaignClipId: id },
);
tool(
  "restore_edit_project",
  ["xeeclip:clips:read", "xeeclip:clips:edit"],
  "EDITOR_WRITE",
  "Restore the canonical editor for an owned generated clip using the existing materializer. Reuses an existing project; does not regenerate the clip.",
  { ...write, clipId: id },
);
tool(
  "get_edit_project",
  "xeeclip:clips:read",
  "READ",
  "Read the SAME canonical EditProject used by the website, including revision and bounded editable summaries. Supply editProjectId or clipId.",
  { editProjectId: id.optional(), clipId: id.optional() },
);
tool(
  "trim_video",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Apply canonical source trim boundaries in seconds to a video element. expectedRevision protects newer website edits.",
  { ...selected, start: seconds, end: seconds },
);
tool(
  "set_crop",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Set canonical normalized edge insets. Retain at least 5% of each source axis.",
  { ...selected, crop },
);
tool(
  "set_zoom",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Set the manual canonical video scale; existing pan clamping and manual precedence apply.",
  { ...selected, scale: z.number().finite().min(0.1).max(4) },
);
tool(
  "set_pan",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Set canonical normalized video offsets; the editor clamps pan to the current zoom.",
  {
    ...selected,
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
  },
);
tool(
  "update_headline",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Change the canonical headline text using the existing fit validator. A headline that does not fit is rejected.",
  { ...selected, text: z.string().min(1).max(1000) },
);
tool(
  "update_caption",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Update a canonical caption cue using only supported caption editing and timing semantics.",
  {
    ...edit,
    captionElementId: id,
    text: z.string().max(1000).optional(),
    start: seconds.optional(),
    end: seconds.optional(),
  },
);
tool(
  "set_caption_style",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Apply one built-in canonical caption preset to the caption track; no arbitrary CSS.",
  {
    ...edit,
    preset: z.enum(
      CAPTION_STYLE_PRESETS.map((p) => p.id) as [string, ...string[]],
    ),
  },
);
tool(
  "set_music",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Select existing editor or campaign-owned music through the canonical audio system. No arbitrary URL/file path; existing loop/ducking rules apply.",
  { ...edit, asset: media, volume: unit.default(1) },
);
tool(
  "set_music_volume",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Set canonical music-track volume. 1 is 100% recorded volume; no hidden gain is added.",
  { ...edit, volume: unit },
);
tool(
  "set_source_volume",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Set the canonical source-video volume. 1 is 100% recorded volume.",
  { ...selected, volume: unit },
);
tool(
  "add_image_overlay",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Add an existing authorized editor/campaign image with canonical image-overlay commands.",
  { ...edit, asset: media },
);
tool(
  "add_logo",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Add an existing authorized editor/campaign logo through the canonical overlay system.",
  { ...edit, asset: media },
);
tool(
  "update_overlay",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Change a canonical image/logo overlay position, size or opacity. Does not accept arbitrary video overlays.",
  {
    ...edit,
    elementId: id,
    x: unit.optional(),
    y: unit.optional(),
    width: unit.min(0.02).optional(),
    height: unit.min(0.02).optional(),
    opacity: unit.optional(),
  },
);
tool(
  "remove_overlay",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Remove an image/logo overlay as a reversible canonical edit. This does not delete its media asset.",
  { ...edit, elementId: id },
);
tool(
  "set_filter",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Apply an existing canonical color filter preset.",
  {
    ...selected,
    preset: z.enum([
      "ORIGINAL",
      "CLEAN",
      "WARM",
      "COOL",
      "CINEMATIC",
      "VIBRANT",
      "SOFT",
      "HIGH_CONTRAST",
      "VINTAGE",
      "BLACK_AND_WHITE",
    ]),
    strength: unit.default(1),
  },
);
tool(
  "set_visual_adjustments",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Apply only supported canonical visual adjustments; the normal renderer and bounds are authoritative.",
  { ...selected, adjustments: visual },
);
tool(
  "undo",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Undo through the canonical website history. Does not create a separate MCP undo stack.",
  edit,
);
tool(
  "redo",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Redo through the canonical website history using the latest expectedRevision.",
  edit,
);
tool(
  "save_edit",
  "xeeclip:clips:edit",
  "EDITOR_WRITE",
  "Verify and return saved canonical state. Commands already autosave; this does not create a redundant revision.",
  edit,
);
tool(
  "export_clip",
  "xeeclip:clips:export",
  "EXPORT",
  "Start the canonical asynchronous export of an owned EditProject revision. Existing Quick Reframe credit policy applies; repeated keys do not render or charge twice.",
  edit,
);
tool(
  "get_export",
  "xeeclip:clips:export",
  "READ",
  "Read canonical export progress and obtain an ownership-protected result/download link when complete.",
  { editProjectId: id, exportId: id.optional() },
);
tool(
  "list_history",
  "xeeclip:history:read",
  "READ",
  "Read paginated canonical History for Create Clips, Quick Reframe and campaign results.",
  page,
);
export const MCP_TOOLS = tools;
