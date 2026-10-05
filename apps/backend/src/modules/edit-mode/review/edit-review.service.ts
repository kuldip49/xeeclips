import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { readAudioState, readSourceAudio } from '../edit-mode-audio';
import { readColor } from '../edit-mode-color';
import { readEditProjectStyle } from '../presets/edit-preset-policy';
import { readScale, readSpeed, readTransform } from '../edit-mode-transform';
import { readZoomEffect } from '../edit-mode-zoom-events';
import { EditChatService } from '../chat/edit-chat.service';
import { EditReviewStore } from './edit-review-store';
import type { EditReview, EditReviewView, ReviewDimension, ReviewSeverity,
  StoredReviewFinding } from './edit-review.types';

type ElementRow = { id: string; type: string; track: number; position: number; startTime: number;
  duration: number; properties: unknown };
type Range = { startSec: number; endSec: number };
type ReviewInput = { message?: unknown; revision?: unknown; selectedElementId?: unknown;
  selectedTimeRange?: unknown; playheadSec?: unknown };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' &&
  !Array.isArray(value) ? value as Record<string, unknown> : {};
const round = (value: number) => Math.round(value * 10) / 10;
const words = (value: unknown) => String(value ?? '').trim().split(/\s+/).filter(Boolean);
const role = (element: ElementRow) => String(record(element.properties).presetRole ??
  record(element.properties).templateRole ?? record(element.properties).semanticRole ?? '').toUpperCase();

@Injectable()
export class EditReviewService {
  constructor(private readonly prisma: PrismaService, private readonly store: EditReviewStore,
    private readonly chat: EditChatService) {}

  async latest(id: string) {
    const review = await this.store.get(id);
    return review ? this.view(review) : null;
  }

  async review(id: string, input: ReviewInput): Promise<EditReviewView> {
    const project = await this.prisma.editProject.findUnique({ where: { id }, include: {
      assets: { orderBy: { createdAt: 'asc' } },
      elements: { orderBy: [{ track: 'asc' }, { position: 'asc' }] }
    } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (input.revision !== undefined && Number(input.revision) !== project.revision) {
      throw new BadRequestException({ code: 'STALE_REVISION',
        message: 'The project changed. Run the review again against the current edit.' });
    }
    const source = project.assets.find((asset) => asset.role === 'SOURCE');
    if (!source) throw new BadRequestException({ code: 'NO_SOURCE',
      message: 'Attach a source video before asking for a review' });
    const elements = project.elements as unknown as ElementRow[];
    const range = this.range(input.selectedTimeRange);
    const selectedId = typeof input.selectedElementId === 'string' ? input.selectedElementId : null;
    const selected = selectedId ? elements.find((item) => item.id === selectedId) : undefined;
    const message = String(input.message ?? 'review my edit').toLowerCase();
    const scope = selected ? 'SELECTION' : range ? 'RANGE' : message.includes('hook') ? 'HOOK'
      : message.includes('caption') ? 'CAPTIONS' : message.includes('audio') || message.includes('music')
        ? 'AUDIO' : message.includes('pacing') ? 'PACING' : 'PROJECT';
    const relevant = selected ? [selected] : range
      ? elements.filter((item) => item.startTime < range.endSec &&
        item.startTime + item.duration > range.startSec) : elements;
    const duration = elements.filter((item) => item.type === 'VIDEO' && item.track === 0)
      .reduce((total, item) => total + item.duration, 0);
    const findings = this.findings(relevant, elements, duration, source.analysis, scope);
    const ordered = findings.sort((a, b) => this.rank(a.severity) - this.rank(b.severity));
    const biggest = ordered.find((item) => item.severity === 'NEEDS_ATTENTION') ??
      ordered.find((item) => item.severity === 'COULD_IMPROVE');
    const sampledMomentsSec = [...new Set([0, range?.startSec, range?.endSec,
      ...elements.filter((item) => ['TEXT', 'IMAGE'].includes(item.type)).slice(0, 3)
        .map((item) => item.startTime), Math.max(0, duration - 0.2)])]
      .filter((value): value is number => Number.isFinite(value)).slice(0, 6).map(round);
    const review: EditReview = { reviewId: randomUUID(), editProjectId: id,
      revision: project.revision, scope,
      summary: biggest ? `Biggest issue: ${biggest.title}` : 'The checked areas look consistent.',
      findings: ordered, sampledMomentsSec, createdAt: new Date().toISOString() };
    await this.store.save(review);
    return this.view(review);
  }

  /** Turns a review suggestion into a normal G proposal. It still changes nothing. */
  async propose(id: string, findingId: string, input: ReviewInput) {
    const review = await this.store.get(id);
    const finding = review?.findings.find((item) => item.id === findingId);
    if (!review || !finding?.applyInstruction) throw new BadRequestException({
      code: 'REVIEW_SUGGESTION_NOT_FOUND', message: 'Run the review again before applying this suggestion' });
    return this.chat.plan(id, { ...input, message: finding.applyInstruction,
      ...(finding.targetElementId ? { selectedElementId: finding.targetElementId,
        selectedTimeRange: null } : {}) });
  }

  private findings(relevant: ElementRow[], all: ElementRow[], duration: number,
    analysis: unknown, scope: EditReview['scope']): StoredReviewFinding[] {
    const allowed = (dimension: ReviewDimension) => scope === 'PROJECT' || scope === 'SELECTION' ||
      scope === 'RANGE' || scope === dimension;
    const out: StoredReviewFinding[] = [];
    const add = (dimension: ReviewDimension, severity: ReviewSeverity, title: string,
      evidence: string[], suggestion: string | null, applyInstruction: string | null,
      previewRange: Range | null = null, evidenceLimit: string | null = null,
      targetElementId: string | null = null) => {
      if (allowed(dimension)) out.push({ id: randomUUID(), dimension, severity, title, evidence,
        suggestion, applyInstruction, previewRange, evidenceLimit, targetElementId });
    };

    const hook = relevant.find((item) => item.type === 'TEXT' && role(item) === 'HOOK') ??
      (scope === 'PROJECT' || scope === 'HOOK'
        ? all.find((item) => item.type === 'TEXT' && role(item) === 'HOOK') : undefined);
    if (hook) {
      const text = String(record(hook.properties).content ?? record(hook.properties).text ?? '');
      const count = words(text).length;
      const seconds = round(hook.duration);
      const crowded = count > Math.max(8, hook.duration * 4.5);
      add('HOOK', crowded ? 'NEEDS_ATTENTION' : count > 10 ? 'COULD_IMPROVE' : 'LOOKS_GOOD',
        crowded ? 'The opening hook is dense for its display time.' : 'The hook timing is readable.',
        [`The hook contains ${count} words and is on screen for ${seconds}s.`,
          `It begins at ${round(hook.startTime)}s.`],
        crowded ? 'Shorten the wording while keeping it grounded in the opening transcript.' : null,
        crowded ? 'Make the existing hook shorter and more curiosity-based. Keep its timing and style.' : null,
        { startSec: hook.startTime, endSec: hook.startTime + hook.duration }, null, hook.id);
    } else if (allowed('HOOK')) add('HOOK', 'COULD_IMPROVE', 'No explicit opening hook is present.',
      ['No text element is marked with the Hook semantic role.'],
      'Consider adding a short hook grounded in the opening transcript.',
      'Add a concise curiosity-based opening hook grounded in the transcript.',
      { startSec: 0, endSec: Math.min(4, duration) });

    const videos = relevant.filter((item) => item.type === 'VIDEO' && item.track === 0);
    if (allowed('PACING') && videos.length) {
      const longest = videos.reduce((best, item) => item.duration > best.duration ? item : best);
      const slow = readSpeed(record(longest.properties));
      const severity = longest.duration > 15 ? 'NEEDS_ATTENTION' : longest.duration > 9
        ? 'COULD_IMPROVE' : 'LOOKS_GOOD';
      add('PACING', severity, severity === 'LOOKS_GOOD'
        ? 'Segment lengths are reasonably controlled.' : 'One section may feel long without a change.',
      [`The longest checked video section is ${round(longest.duration)}s.`,
        `Its playback speed is ${slow}x.`, `The checked timeline has ${videos.length} video section(s).`],
      severity === 'LOOKS_GOOD' ? null : 'Preview this section and trim only if the speech has a low-information pause.',
      severity === 'LOOKS_GOOD' ? null : `Review and tighten the video around ${round(longest.startTime)}s without changing unrelated cuts.`,
      { startSec: longest.startTime, endSec: longest.startTime + longest.duration },
      'Stored timing can identify a long section; it cannot prove the section is visually uninteresting.',
      longest.id);
    }

    const captions = relevant.filter((item) => item.type === 'SUBTITLE');
    if (allowed('CAPTIONS')) {
      if (!captions.length) add('CAPTIONS', 'COULD_IMPROVE', 'No captions are present in this scope.',
        ['The checked range contains no subtitle elements.'], 'Add captions if spoken content needs to be read.',
        'Generate captions from the existing timed transcript.', null,
        'Caption generation requires cached word timings.');
      else {
        const crowded = captions.filter((item) => words(record(item.properties).text ??
          record(item.properties).content).length > Math.max(8, item.duration * 4.5));
        const manual = captions.filter((item) => record(item.properties).manualEdited === true).length;
        add('CAPTIONS', crowded.length ? 'NEEDS_ATTENTION' : 'LOOKS_GOOD',
          crowded.length ? 'Some captions are dense for their timing.' : 'Caption density is readable.',
          [`${captions.length} caption(s) were checked.`, `${crowded.length} exceed the density guideline.`,
            `${manual} contain manual wording edits.`],
          crowded.length ? 'Reduce density without replacing manually corrected wording.' : null,
          crowded.length ? 'Make the existing captions easier to read without regenerating them or changing manual corrections.' : null);
      }
    }

    const checkedVideos = relevant.filter((item) => item.type === 'VIDEO');
    if (allowed('FRAMING') && checkedVideos.length) {
      const aggressive = checkedVideos.filter((item) => {
        const p = record(item.properties); const transform = readTransform(p);
        return readScale(p) > 1.45 || transform.crop.left + transform.crop.right > 0.35 ||
          transform.crop.top + transform.crop.bottom > 0.35;
      });
      add('FRAMING', aggressive.length ? 'NEEDS_ATTENTION' : 'LOOKS_GOOD',
        aggressive.length ? 'Some framing removes a large part of the source.' : 'Stored framing is within conservative bounds.',
        [`${aggressive.length} of ${checkedVideos.length} checked segment(s) use aggressive scale or crop.`],
        aggressive.length ? 'Reduce crop or scale while preserving face and information regions.' : null,
        aggressive.length ? 'Crop less.' : null,
        null, record(analysis).frames ? null : 'No reliable representative frame is cached, so this is a transform check, not a visual composition judgement.',
        aggressive[0]?.id ?? null);
    }

    const zooms = relevant.filter((item) => item.type === 'EFFECT' && readZoomEffect(record(item.properties)));
    if (allowed('ZOOM')) {
      const aggressive = zooms.filter((item) => (readZoomEffect(record(item.properties))?.scale ?? 1) > 1.35);
      const frequent = duration > 0 && zooms.length / duration * 60 > 8;
      add('ZOOM', aggressive.length || frequent ? 'COULD_IMPROVE' : 'LOOKS_GOOD',
        aggressive.length ? 'One or more zooms are strong.' : frequent ? 'Zooms may be too frequent.' : 'Zoom use is restrained.',
        [`${zooms.length} zoom(s) are stored in the checked scope.`, `${aggressive.length} exceed 1.35x.`],
        aggressive.length || frequent ? 'Keep zooms subtle and reserve them for important spoken moments.' : null,
        aggressive.length || frequent ? 'Make the existing zooms more subtle and keep only meaningful emphasis.' : null);
    }

    if (allowed('COLOR') && checkedVideos.length) {
      const strong = checkedVideos.filter((item) => {
        const c = readColor(record(item.properties));
        return Math.abs(c.exposure) > 0.35 || Math.abs(c.contrast) > 0.35 ||
          Math.abs(c.saturation) > 0.35 || Math.abs(c.temperature) > 0.35;
      });
      add('COLOR', strong.length ? 'COULD_IMPROVE' : 'LOOKS_GOOD',
        strong.length ? 'The color treatment is relatively strong.' : 'Color adjustments are restrained.',
        [`${strong.length} of ${checkedVideos.length} checked segment(s) exceed the moderate adjustment range.`],
        strong.length ? 'Pull the strongest adjustment closer to neutral for consistency.' : null,
        strong.length ? 'Reduce the strongest color adjustments while preserving the current look.' : null,
        null, 'Stored controls are verifiable; exposure quality cannot be confirmed without a reliable sampled frame.');
    }

    if (allowed('AUDIO')) {
      const music = relevant.filter((item) => item.type === 'AUDIO');
      const sourceVideo = all.find((item) => item.type === 'VIDEO');
      const sourceState = readSourceAudio(record(sourceVideo?.properties));
      const loud = music.filter((item) => readAudioState(record(item.properties)).volume > 0.35);
      const abrupt = music.filter((item) => { const a = readAudioState(record(item.properties));
        return a.fadeInSec === 0 || a.fadeOutSec === 0; });
      const severity = sourceState.muted || loud.length ? 'NEEDS_ATTENTION' : abrupt.length
        ? 'COULD_IMPROVE' : 'LOOKS_GOOD';
      add('AUDIO', severity, sourceState.muted ? 'Source speech is muted.' : loud.length
        ? 'Music may compete with speech.' : abrupt.length ? 'Music has an abrupt edge.' : 'Stored audio balance is conservative.',
      [`Source audio is ${sourceState.muted ? 'muted' : `at ${Math.round(sourceState.volume * 100)}%`}.`,
        `${music.length} music track(s) are in scope.`, `${loud.length} are above 35% volume.`,
        `${abrupt.length} have a zero-length fade at one edge.`],
      severity === 'LOOKS_GOOD' ? null : 'Keep music low under speech and use short fades at exposed edges.',
      severity === 'LOOKS_GOOD' ? null : 'Lower the existing music under speech and add gentle fades without changing the track.' );
    }

    const overlays = relevant.filter((item) => ['IMAGE', 'TEXT'].includes(item.type) && role(item) !== 'HOOK');
    if (allowed('OVERLAYS') && overlays.length) {
      const large = overlays.filter((item) => Number(record(item.properties).width ?? 0) > 0.45 ||
        Number(record(item.properties).height ?? 0) > 0.35);
      add('OVERLAYS', large.length ? 'COULD_IMPROVE' : 'LOOKS_GOOD',
        large.length ? 'An overlay occupies a large part of the frame.' : 'Overlay sizing is restrained.',
        [`${overlays.length} overlay(s) were checked.`, `${large.length} exceed the conservative size guide.`],
        large.length ? 'Reduce the large overlay and keep it inside safe margins.' : null,
        large.length ? 'Make this smaller.' : null, null, null, large[0]?.id ?? null);
    }

    if (allowed('STRUCTURE')) {
      const lastVideo = all.filter((item) => item.type === 'VIDEO' && item.track === 0).at(-1);
      add('STRUCTURE', duration < 3 || !lastVideo ? 'NEEDS_ATTENTION' : 'LOOKS_GOOD',
        duration < 3 || !lastVideo ? 'The edit does not have a complete video arc.' : 'The edit has a defined beginning and ending.',
        [`The edited duration is ${round(duration)}s.`, `The ending is at ${round(lastVideo ? lastVideo.startTime + lastVideo.duration : 0)}s.`],
        duration < 3 ? 'Build a complete beginning, middle and ending before export.' : null, null,
        lastVideo ? { startSec: Math.max(0, duration - 3), endSec: duration } : null,
        'Payoff quality is editorial and needs transcript or visual evidence; timing alone cannot prove it.');
    }
    return out;
  }

  private view(review: EditReview): EditReviewView {
    const { editProjectId: _private, findings, ...view } = review;
    return { ...view, findings: findings.map(({ targetElementId: _target, ...finding }) => finding) };
  }
  private rank(value: ReviewSeverity) { return value === 'NEEDS_ATTENTION' ? 0
    : value === 'COULD_IMPROVE' ? 1 : 2; }
  private range(value: unknown): Range | null {
    const data = record(value); const startSec = Number(data.startSec); const endSec = Number(data.endSec);
    return Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec
      ? { startSec, endSec } : null;
  }
}
