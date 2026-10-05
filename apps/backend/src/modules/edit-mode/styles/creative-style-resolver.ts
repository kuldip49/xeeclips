// Step 10.1: the ONE place style precedence is decided.
//
//   1. explicit natural-language instruction   (the brief says "yellow captions")
//   2. explicit manually selected component    (the user picked a caption style)
//   3. reference-derived style                 (measured from a reference video)
//   4. full template                           (the default bundle the user picked)
//   5. automatic defaults                      (nothing chosen: leave it to the pipeline)
//
// Frontend and backend both call this (the frontend through the API), so the
// order can never be re-implemented differently somewhere else.

import { componentStyle, fullTemplate, STYLE_CATEGORIES, type ComponentStyle, type StyleCategory,
  type StyleSpec } from './creative-style-library';

export const STYLE_SOURCES = ['INSTRUCTION', 'COMPONENT', 'REFERENCE', 'TEMPLATE', 'DEFAULT'] as const;
export type StyleSource = typeof STYLE_SOURCES[number];

/** A layer's choice for one category: a library style, optionally refined. */
export type StyleChoice = { styleId?: string; overrides?: Record<string, unknown> };

export type ResolvedComponent = {
  category: StyleCategory; source: StyleSource; styleId: string | null; name: string | null;
  spec: StyleSpec | null; supported: boolean; note?: string;
  /** Lower-priority choices this one overrode, for transparency in the UI. */
  overridden: Array<{ source: StyleSource; styleId: string | null }>;
};

export type ResolvedCreativeStyle = {
  templateId: string | null;
  components: Record<StyleCategory, ResolvedComponent>;
  /** True when anything beyond automatic defaults was chosen. */
  styled: boolean;
  notes: string[];
};

export type StyleLayers = {
  instruction?: Partial<Record<StyleCategory, StyleChoice>>;
  components?: Partial<Record<StyleCategory, string>>;
  reference?: Partial<Record<StyleCategory, StyleChoice>>;
  templateId?: string | null;
  /** User-saved styles by stable id (Step 17), resolved by the caller. */
  saved?: Record<string, { category: StyleCategory; spec: StyleSpec; name: string }>;
};

export function resolveCreativeStyle(layers: StyleLayers): ResolvedCreativeStyle {
  const template = fullTemplate(layers.templateId ?? null);
  const notes: string[] = [];
  if (layers.templateId && !template) notes.push(`Unknown template "${layers.templateId}" was ignored.`);
  const components = {} as Record<StyleCategory, ResolvedComponent>;
  for (const category of STYLE_CATEGORIES) {
    const ordered: Array<{ source: StyleSource; choice: StyleChoice | undefined }> = [
      { source: 'INSTRUCTION', choice: layers.instruction?.[category] },
      { source: 'COMPONENT', choice: layers.components?.[category]
        ? { styleId: layers.components[category] } : undefined },
      { source: 'REFERENCE', choice: layers.reference?.[category] },
      { source: 'TEMPLATE', choice: template?.components[category]
        ? { styleId: template.components[category] } : undefined }
    ];
    const present = ordered.filter((layer) => layer.choice &&
      (layer.choice.styleId || (layer.choice.overrides && Object.keys(layer.choice.overrides).length)));
    if (!present.length) {
      components[category] = { category, source: 'DEFAULT', styleId: null, name: null, spec: null,
        supported: true, overridden: [] };
      continue;
    }
    // The winner is the highest-priority layer. An instruction that only
    // REFINES ("make the captions yellow") keeps the next layer's base style and
    // overlays its overrides, so it changes what was asked and nothing else.
    const winner = present[0];
    let base: ComponentStyle | undefined;
    let savedSpec: { spec: StyleSpec; name: string } | undefined;
    for (const layer of present) {
      const id = layer.choice?.styleId;
      if (!id) continue;
      const saved = layers.saved?.[id];
      if (saved && saved.category === category) { savedSpec = saved; break; }
      const style = componentStyle(id);
      if (style && style.category === category) { base = style; break; }
      notes.push(`${category}: unknown style "${id}" from ${layer.source.toLowerCase()} was ignored.`);
    }
    const overrides = present.slice().reverse().reduce<Record<string, unknown>>((merged, layer) =>
      ({ ...merged, ...(layer.choice?.overrides ?? {}) }), {});
    const spec = { ...(savedSpec?.spec ?? base?.spec ?? {}), ...overrides } as StyleSpec;
    if (!savedSpec && !base && !Object.keys(overrides).length) {
      components[category] = { category, source: 'DEFAULT', styleId: null, name: null, spec: null,
        supported: true, overridden: [] };
      continue;
    }
    if (base && !base.supported) notes.push(`${base.name}: ${base.note}`);
    components[category] = {
      category, source: winner.source,
      styleId: winner.choice?.styleId ?? base?.id ?? null,
      name: savedSpec?.name ?? base?.name ?? 'Custom',
      spec, supported: base ? base.supported : true, ...(base?.note ? { note: base.note } : {}),
      overridden: present.slice(1).map((layer) => ({ source: layer.source,
        styleId: layer.choice?.styleId ?? null }))
    };
  }
  const styled = Object.values(components).some((component) => component.source !== 'DEFAULT');
  return { templateId: template?.id ?? null, components, styled, notes };
}
