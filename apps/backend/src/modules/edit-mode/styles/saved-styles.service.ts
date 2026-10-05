// Step 17: user-saved component styles ("My Podcast Captions", "My Finance Color").
//
// A saved style is a component SPEC under a stable id. The name is a label: the
// AI resolves "my usual podcast captions" to ONE id (or asks when ambiguous) and
// every later use goes by that id, never by fuzzy name matching at apply time.

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { componentStyle, STYLE_CATEGORIES, type StyleCategory, type StyleSpec } from './creative-style-library';

const OWNER = 'LOCAL';
const MAX_SAVED = 200;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export type SavedStyleView = { id: string; category: StyleCategory; name: string; spec: StyleSpec;
  createdAt: Date; updatedAt: Date };

/** Words that carry no identity in a style name ("my usual ... captions"). */
const FILLER = /\b(?:my|usual|saved|normal|favou?rite|the|style|look|captions?|subtitles?|colou?rs?|grade|text|hook|intro|zooms?)\b/giu;
const nameKey = (value: string) => value.toLowerCase().replace(FILLER, ' ').replace(/[^a-z0-9 ]/gu, ' ')
  .replace(/\s+/gu, ' ').trim();

@Injectable()
export class SavedStylesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(category?: string) {
    const rows = await this.prisma.savedStyle.findMany({ where: { ownerScope: OWNER,
      ...(category ? { category: category.toUpperCase() } : {}) }, orderBy: { updatedAt: 'desc' } });
    return rows as unknown as SavedStyleView[];
  }

  async get(id: string) {
    const row = await this.prisma.savedStyle.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Saved style not found');
    return row as unknown as SavedStyleView;
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.savedStyle.delete({ where: { id } });
    return { deleted: true };
  }

  /** Create from an explicit spec, a library style id, or the current project. */
  async create(input: { category?: unknown; name?: unknown; spec?: unknown; styleId?: unknown;
    fromProjectId?: unknown }) {
    const category = String(input.category ?? '').toUpperCase() as StyleCategory;
    if (!(STYLE_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException(`category must be one of ${STYLE_CATEGORIES.join(', ')}`);
    }
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) throw new BadRequestException('name is required');
    let spec: StyleSpec | null = null;
    if (typeof input.styleId === 'string') {
      const base = componentStyle(input.styleId);
      if (!base || base.category !== category) throw new BadRequestException('Unknown style for that category');
      spec = base.spec;
    } else if (typeof input.fromProjectId === 'string') {
      spec = await this.captureFromProject(input.fromProjectId, category);
    } else if (input.spec && typeof input.spec === 'object' && !Array.isArray(input.spec)) {
      spec = input.spec as StyleSpec;
    }
    if (!spec) throw new BadRequestException('Provide spec, styleId or fromProjectId');
    const json = JSON.stringify(spec);
    if (json.length > 4000) throw new BadRequestException('A saved style is limited to 4 KB');
    if (await this.prisma.savedStyle.count({ where: { ownerScope: OWNER } }) >= MAX_SAVED) {
      throw new BadRequestException(`At most ${MAX_SAVED} saved styles`);
    }
    try {
      return await this.prisma.savedStyle.create({ data: { ownerScope: OWNER, category, name,
        spec: JSON.parse(json) as Prisma.InputJsonValue } }) as unknown as SavedStyleView;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`You already have a ${category.toLowerCase()} style named "${name}"`);
      }
      throw error;
    }
  }

  /** What the project's current captions / colour look like, as a reusable spec. */
  private async captureFromProject(projectId: string, category: StyleCategory): Promise<StyleSpec> {
    const project = await this.prisma.editProject.findUnique({ where: { id: projectId },
      include: { elements: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (category === 'CAPTIONS') {
      const caption = project.elements.find((element) => element.type === 'SUBTITLE');
      if (!caption) throw new BadRequestException('This project has no captions to save');
      const p = record(caption.properties);
      const active = record(p.activeWord);
      const plate = record(p.background);
      return { preset: String(p.captionStyleId ?? 'CLEAN'), fontSize: Number(p.fontSize) || undefined,
        color: typeof p.color === 'string' ? p.color : undefined,
        fontWeight: Number(p.fontWeight) || undefined, uppercase: p.uppercase === true,
        activeWord: active.enabled === true, activeWordColor: typeof active.color === 'string' ? active.color : undefined,
        plate: plate.enabled === false ? 'none' : typeof plate.color === 'string' ? plate.color : undefined,
        plateOpacity: Number(plate.opacity) || undefined, y: Number(p.y) || undefined };
    }
    if (category === 'COLOR') {
      const video = project.elements.find((element) => element.type === 'VIDEO');
      const p = record(video?.properties);
      const adjustments = Object.fromEntries(Object.entries(record(p.colorAdjustments))
        .filter(([, value]) => typeof value === 'number' && Math.abs(value) > 1e-6)) as Record<string, number>;
      return { filterId: String(p.colorFilterId ?? 'ORIGINAL'), strength: Number(p.colorFilterStrength ?? 1),
        overrides: adjustments };
    }
    throw new BadRequestException(`Capturing ${category.toLowerCase()} from a project is not supported; ` +
      'save a library style or an explicit spec instead');
  }

  /**
   * "use my usual podcast captions" -> exactly one saved style id, or an honest
   * question when there is none or more than one plausible match.
   */
  async resolveByName(category: StyleCategory, spoken: string):
    Promise<{ style: SavedStyleView } | { question: string }> {
    const saved = await this.list(category);
    if (!saved.length) return { question: `You have no saved ${category.toLowerCase()} styles yet.` };
    const wanted = nameKey(spoken);
    const scored = saved.map((style) => {
      const key = nameKey(style.name);
      const words = wanted.split(' ').filter(Boolean);
      const hits = words.filter((word) => key.split(' ').includes(word)).length;
      return { style, score: key === wanted ? 100 : words.length ? hits / words.length : 0 };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) {
      return { question: `Which saved ${category.toLowerCase()} style? You have: ${saved.map((s) => s.name).join(', ')}.` };
    }
    if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].score < 100) {
      return { question: `Did you mean ${scored.filter((item) => item.score === scored[0].score)
        .map((item) => `"${item.style.name}"`).join(' or ')}?` };
    }
    return { style: scored[0].style };
  }

  /** Stable-id lookup for the style resolver. */
  async byIds(ids: string[]) {
    if (!ids.length) return {};
    const rows = await this.prisma.savedStyle.findMany({ where: { id: { in: ids } } });
    return Object.fromEntries(rows.map((row) => [row.id, { category: row.category as StyleCategory,
      spec: row.spec as unknown as StyleSpec, name: row.name }]));
  }
}
