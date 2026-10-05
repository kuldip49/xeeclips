// Workstream F template request shapes.
//
// Every field is `unknown` on purpose, exactly as the other EditMode DTOs are:
// the bounds live in edit-template-schema.ts so the editor, an assistant bundle
// and a raw HTTP request all get the same answer for the same value, rather
// than three decorator sets drifting apart.

export class ApplyEditTemplateDto {
  revision?: unknown;
  templateId?: unknown;
}

export class CreateEditTemplateDto {
  /** Capture this project's current style. Omit to post a template directly. */
  editProjectId?: unknown;
  name?: unknown;
  description?: unknown;
  /** Opt-in asset binding. Off by default, so a template stays portable. */
  includeLogo?: unknown;
  includeMusic?: unknown;
  version?: unknown;
  project?: unknown;
  text?: unknown;
  captions?: unknown;
  logo?: unknown;
  color?: unknown;
  audio?: unknown;
  zoom?: unknown;
  reframe?: unknown;
  informationRegion?: unknown;
  assets?: unknown;
}

export class UpdateEditTemplateDto {
  name?: unknown;
  description?: unknown;
  /** A full replacement style payload; omit to rename only. */
  template?: unknown;
}

export class DuplicateEditTemplateDto {
  name?: unknown;
}
