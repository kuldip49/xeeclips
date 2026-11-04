import {EditorControlService} from '../edit-mode/editor-control.service';
import { readTextStyle } from "../edit-mode/edit-mode-text";
import { Injectable } from "@nestjs/common";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AuthService } from "../auth/auth.service";
import { requestIdentity } from "../auth/request-context";
import { VideoImportService } from "../videos/video-import.service";
import { VideosService } from "../videos/videos.service";
import { parseClipCreationRequest } from "../videos/clip-selection.service";
import { QuickReframeService } from "../quick-reframe/quick-reframe.service";
import { CampaignsService } from "../campaigns/campaigns.service";
import {
  EditModeService,
  type AssistantBundleCommand,
} from "../edit-mode/edit-mode.service";
import { EditModeRenderService } from "../edit-mode/render/edit-mode-render.service";
import { GeneratedClipEditProjectMaterializerService } from "../edit-mode/generated-clip-edit-project-materializer.service";
import {
  performanceContext,
  createPerformanceTelemetry,
} from "../processing/performance-telemetry";
import { mcpConfig } from "./mcp-config";
import { McpToolError, safeMcpError } from "./mcp-operations.service";
const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
const templates: Record<string, string> = {
  STYLE_ZERO: "AUTOMATIC_1",
  STYLE_ONE: "AUTOMATIC_2",
  STYLE_TWO: "AUTOMATIC_3_STYLE_TWO",
};
const quickStyles = {
  STYLE_ZERO: "STYLEZERO",
  STYLE_ONE: "STYLEONE",
  STYLE_TWO: "STYLETWO",
} as const;
const website = (relative: string) =>
  new URL(relative, mcpConfig().frontend).href;
const api = (relative: string | null | undefined) =>
  relative && /^\/(?:edit-mode|generated-clips|quick-reframe)\//.test(relative)
    ? new URL(relative, mcpConfig().issuer).href
    : null;
function page<T>(items: T[], limit: number, id: (v: T) => string) {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? id(items[limit - 1]) : null,
  };
}
@Injectable()
export class McpAdapterService {
  constructor(
    private readonly auth: AuthService,
    private readonly videos: VideosService,
    private readonly imports: VideoImportService,
    private readonly quick: QuickReframeService,
    private readonly campaigns: CampaignsService,
    private readonly edit: EditModeService,
    private readonly render: EditModeRenderService,
    private readonly materializer: GeneratedClipEditProjectMaterializerService,
    private readonly editorControl?: EditorControlService,
  ) {}
  private async pro(mode: string, userId: string) {
    if (
      mode === "XEEPRO" &&
      !(await this.auth.activeAccount(userId)).aiProcessingConsentAt
    )
      throw new McpToolError(
        "AI_CONSENT_REQUIRED",
        "Allow AI processing in XeeClip Settings first.",
      );
  }
  private projectSummary(p: any) {
    const elements: any[] = p.elements || [],
      videos = elements.filter((e) => e.type === "VIDEO"),
      captions = elements.filter((e) => e.type === "SUBTITLE");
    const headline =
      elements.find(
        (e) =>
          e.type === "TEXT" &&
          [e.properties?.presetRole, e.properties?.templateRole].includes(
            "HOOK",
          ),
      ) || elements.find((e) => e.type === "TEXT");
    const pickText = (e: any) => ({
      elementId: e.id,
      type: e.type,
      track: e.track,
      text: String(e.properties?.content || ""),
      start: e.startTime,
      end: e.startTime + e.duration,
      hidden: e.properties?.hidden === true,
      semanticRole:
        e.properties?.presetRole || e.properties?.templateRole || null,
      box: {
        x: e.properties?.x ?? 0,
        y: e.properties?.y ?? 0,
        width: e.properties?.width ?? 1,
        height: e.properties?.height ?? 1,
      },
      style: {
        ...readTextStyle(e.properties),
        captionStyleId: e.properties?.captionStyleId,
      },
    });
    return {
      editProjectId: p.id,
      name: p.name,
      revision: p.revision,
      updatedAt: p.updatedAt,
      websiteUrl: website("/edit-mode/" + p.id),
      websiteUrlPurpose: "OPTIONAL_HUMAN_UI_NOT_REQUIRED_FOR_MCP",
      editorAuthentication: "MCP_OAUTH_BEARER",
      execution: "SERVER_SIDE_CANONICAL_EDITOR",
      coordinateSpace: "NORMALIZED_TOP_LEFT_CANVAS",
      sourceContent:
        "Editable layers below are separate from embedded source pixels/audio. Removing a layer never erases source captions or titles already present in the video.",
      textLayers: elements
        .filter((e) => e.type === "TEXT")
        .slice(0, 200)
        .map(pickText),
      textLayerCount: elements.filter((e) => e.type === "TEXT").length,
      textLayersTruncated:
        elements.filter((e) => e.type === "TEXT").length > 200,
      duration: videos.reduce(
        (n, e) => Math.max(n, e.startTime + e.duration),
        0,
      ),
      aspectRatio: object(p.settings).aspectRatio || "SOURCE",
      headline: headline ? pickText(headline) : null,
      videos: videos.slice(0, 50).map((e) => ({
        elementId: e.id,
        start: e.startTime,
        duration: e.duration,
        sourceStart: e.trimStart,
        sourceEnd: e.trimEnd,
        crop: object(e.properties).crop || {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        },
        zoom: object(e.properties).scale ?? 1,
        pan: {
          x: object(e.properties).offsetX || 0,
          y: object(e.properties).offsetY || 0,
        },
        volume: object(e.properties).sourceVolume ?? 1,
        muted: object(e.properties).sourceMuted === true,
        adjustments: object(e.properties).colorAdjustments || null,
      })),
      captions: captions.slice(0, 200).map(pickText),
      captionCount: captions.length,
      captionsTruncated: captions.length > 200,
      music: elements
        .filter((e) => e.type === "AUDIO")
        .slice(0, 50)
        .map((e) => ({
          elementId: e.id,
          assetId: e.assetId,
          start: e.startTime,
          duration: e.duration,
          volume: object(e.properties).volume ?? 1,
          muted: object(e.properties).muted === true,
        })),
      overlays: elements
        .filter((e) => e.type === "IMAGE")
        .slice(0, 60)
        .map((e) => ({
          elementId: e.id,
          assetId: e.assetId,
          x: e.properties?.x,
          y: e.properties?.y,
          width: e.properties?.width,
          height: e.properties?.height,
          opacity: e.properties?.opacity ?? 1,
          role: e.properties?.role || "IMAGE",
        })),
      assets: (p.assets || []).slice(0, 100).map((a: any) => ({
        assetId: a.id,
        role: a.role,
        name: a.originalName,
        duration: a.duration,
        width: a.width,
        height: a.height,
        campaignAssetId: object(a.metadata).campaignAssetId || null,
      })),
    };
  }
  async exportFile(projectId: string, exportId: string, range?: string) {
    const asset = await this.render.exportForOperation(projectId, exportId);
    if (!asset) throw new McpToolError("NOT_FOUND", "Export not found.");
    return this.edit.assetFile(asset.id, range);
  }
  private reframeSummary(q: any) {
    const status = ["READY", "COMPLETE", "EDITING"].includes(q.status)
      ? "COMPLETE"
      : q.status === "FAILED" || q.status === "CANCELED"
        ? "FAILED"
        : q.status === "INPUT"
          ? "QUEUED"
          : "PROCESSING";
    return {
      jobId: "r:" + q.id,
      reframeId: q.id,
      editProjectId: q.editProjectId,
      status,
      progress: q.progress,
      mode: q.mode,
      style: q.styleTwoApplied
        ? "STYLE_TWO"
        : q.styleOneApplied
          ? "STYLE_ONE"
          : q.styleZeroApplied
            ? "STYLE_ZERO"
            : null,
      revision: q.revision,
      resultUrl: website("/quick-reframe?video=" + q.id + "&step=result"),
      editorUrl: website("/edit-mode/" + q.editProjectId),
      previewUrl: api(q.previewUrl || q.originalPreviewUrl),
      errorCode:
        q.errorCode === "XEEPRO_BUSY"
          ? "XEEPRO_BUSY"
          : status === "FAILED"
            ? "JOB_FAILED"
            : null,
      recommendedPollAfterMs: 5000,
    };
  }
  private target(project: any, type: string, id?: string) {
    const rows = project.elements.filter((e: any) => e.type === type);
    const hit = id
      ? rows.find((e: any) => e.id === id)
      : type === "TEXT"
        ? rows.find((e: any) =>
            [e.properties?.presetRole, e.properties?.templateRole].includes(
              "HOOK",
            ),
          ) || rows[0]
        : rows.length === 1
          ? rows[0]
          : null;
    if (!hit)
      throw new McpToolError(
        id ? "NOT_FOUND" : "INVALID_INPUT",
        id
          ? "Element not found."
          : "Choose an explicit element from the project.",
      );
    return hit;
  }
  private async asset(
    project: any,
    ref: any,
    role: "AUDIO" | "IMAGE" | "LOGO",
    auth: AuthInfo,
  ) {
    if (ref.kind === "CAMPAIGN_ASSET") {
      if (!auth.scopes.includes("xeeclip:campaigns:read"))
        throw new McpToolError(
          "INSUFFICIENT_SCOPE",
          "Allow campaign access before using its assets.",
          { requiredScopes: ["xeeclip:clips:edit", "xeeclip:campaigns:read"] },
        );
      return this.campaigns.useStoredAsset(
        project.id,
        ref.campaignId,
        ref.assetId,
        role,
        project.revision,
      );
    }
    const a = project.assets.find(
      (a: any) => a.id === ref.assetId && a.role === role,
    );
    if (!a)
      throw new McpToolError(
        "NOT_FOUND",
        "Choose an asset belonging to this project.",
      );
    return { assetId: a.id, revision: project.revision };
  }
  private async bundle(
    id: string,
    revision: number,
    commands: AssistantBundleCommand[],
  ) {
    if (!commands.length)
      throw new McpToolError("INVALID_INPUT", "Provide an edit to apply.");
    const p = await this.edit.applyAssistantBundle(id, revision, {
      proposalId: requestIdentity.getStore()?.operationId || "remote-edit",
      summary: "Explicit remote editor change",
      userMessage: "Apply the requested XeeClip edit.",
      commands,
      actor: "MANUAL_USER_ACTION",
      onInvalid: "ABORT",
    });
    return { editProjectId: id, revision: p.revision, saved: true };
  }
  /** Arguments have passed the strict catalog schema. Only named application commands are constructed here. */
  async execute(name: string, a: any, auth: AuthInfo): Promise<any> {
    const result=await this.executeOperation(name,a,auth);
    if(result?.editProjectId && typeof result.revision==='number' && name!=='xeeclip_get_edit_project' && auth.scopes.includes('xeeclip:clips:edit') && !['xeeclip_list_edit_elements','xeeclip_get_edit_layout','xeeclip_preview_element_placement','xeeclip_check_edit_requirements','xeeclip_get_export'].includes(name)) await this.campaigns.refreshForEditor(result.editProjectId);
    return result;
  }
  private async executeOperation(name:string,a:any,auth:AuthInfo):Promise<any> {
    const userId = String(auth.extra!.userId),
      tool = name.replace(/^xeeclip_/, "");
    if(tool==='get_editor_capabilities')return this.editorControl!.capabilities();
    if(tool==='list_edit_elements')return this.editorControl!.elements(a.editProjectId,a.offset,a.limit);
    if(tool==='get_edit_layout')return this.editorControl!.layout(a.editProjectId);
    if(tool==='preview_element_placement'){const {editProjectId,...input}=a;return this.editorControl!.placement(editProjectId,input);}
    if(tool==='check_edit_requirements')return this.editorControl!.requirements(a.editProjectId,a.requirements);
    if(tool==='apply_edit_commands')return this.editorControl!.apply(a.editProjectId,a.expectedRevision,a.commands);
    if(tool==='remove_caption_group')return this.editorControl!.removeCaptionGroup(a.editProjectId,a.expectedRevision,a.groupId);
    if(tool==='change_template')return this.editorControl!.template(a.editProjectId,a.expectedRevision,a.targetTemplate);
    if(tool==='apply_editor_preset')return this.editorControl!.preset(a.editProjectId,a.expectedRevision,a.presetId);
    if(tool==='adjust_source_range'){const r=await this.edit.adjustSourceRange(a.editProjectId,{revision:a.expectedRevision,start:a.start,end:a.end,startDelta:a.startDelta,endDelta:a.endDelta});return {editProjectId:r.id,revision:r.revision,saved:true};}
    if (tool === "get_account" || tool === "get_credits") {
      const u = await this.auth.activeAccount(userId);
      return tool === "get_credits"
        ? { credits: u.creditBalance, unlimited: u.role === "ADMIN" }
        : {
            displayName: u.displayName,
            status: u.status,
            aiProcessingConsent: !!u.aiProcessingConsentAt,
            unlimited: u.role === "ADMIN",
          };
    }
    if (tool === "get_supported_sources")
      return this.imports.supportedSources();
    if (tool === "import_source")
      return this.imports.importSource(a.url, a.title);
    if (tool === "get_source_import") {
      const result = await this.imports.sourceImportSummary(a.importId);
      return "errorCode" in result
        ? {
            ...result,
            error: safeMcpError(new McpToolError(result.errorCode!, "")),
          }
        : result;
    }
    if (tool === "list_sources")
      return this.videos.sourcePage(a.limit, a.cursor);
    if (tool === "get_source") return this.videos.sourceSummary(a.sourceId);
    if (tool === "list_clips")
      return this.videos.clipPage(a.limit, a.cursor, a.sourceId);
    if (tool === "get_clip") {
      const c = await this.videos.clipSummary(a.clipId);
      return {
        ...c,
        playbackUrl: api(c.playbackUrl),
        editorUrl: c.editProjectId
          ? website("/edit-mode/" + c.editProjectId)
          : null,
      };
    }
    if (tool === "create_clips") {
      await this.pro(a.mode, userId);
      const source = await this.videos.sourceSummary(a.sourceId);
      if (source.status !== "COMPLETED")
        throw new McpToolError(
          "UNSUPPORTED_SOURCE",
          "Wait for source analysis to complete.",
        );
      const request = parseClipCreationRequest({
        requestedClipCount: a.clipCount,
        outputStyle: "AI_EDITED",
        regenerate: true,
        generation: {
          templateId: templates[a.style],
          brief: a.instruction || "",
          look: templates[a.style],
        },
      });
      await performanceContext.run(
        createPerformanceTelemetry(
          a.mode === "XEEPRO" ? "ONLINE" : "FALLBACK_ONLY",
        ),
        () =>
          this.videos.selectClips(a.sourceId, {
            ...request,
            generationMode: a.mode === "XEEPRO" ? "ONLINE" : "FALLBACK_ONLY",
          }),
      );
      const current = await this.videos.sourceSummary(a.sourceId);
      return {
        jobId:
          "c:" +
          current.job!.id +
          ":" +
          current.job!.clipRequestedAt!.getTime(),
        sourceId: a.sourceId,
        status: "QUEUED",
        recommendedPollAfterMs: 5000,
      };
    }
    if (tool === "quick_reframe") {
      await this.pro(a.mode, userId);
      return this.quick.fromSource(
        a.sourceId,
        a.mode,
        quickStyles[a.style as keyof typeof quickStyles],
        a.crop,
      );
    }
    if (tool === "get_reframe_result")
      return this.reframeSummary(await this.quick.get(a.reframeId));
    if (tool === "get_job") {
      const [kind, id, stamp] = a.jobId.split(":");
      if (kind === "c")
        return {
          jobId: a.jobId,
          ...(await this.videos.generationJobSummary(id, Number(stamp))),
        };
      if (kind === "r") return this.reframeSummary(await this.quick.get(id));
      if (!auth.scopes.includes("xeeclip:campaigns:read"))
        throw new McpToolError(
          "INSUFFICIENT_SCOPE",
          "Allow campaign access to inspect this job.",
          { requiredScopes: ["xeeclip:clips:read", "xeeclip:campaigns:read"] },
        );
      return { jobId: a.jobId, ...(await this.campaigns.generationRun(id)) };
    }
    if (tool === "list_campaigns") {
      const rows = await this.campaigns.list({
        limit: a.limit + 1,
        offset: a.offset,
      });
      return {
        items: rows.slice(0, a.limit),
        nextOffset: rows.length > a.limit ? a.offset + a.limit : null,
      };
    }
    if (tool === "get_campaign") {
      const c = (await this.campaigns.detail(
        a.campaignId,
        { limit: a.limit + 1, offset: a.offset },
        false,
      )) as any;
      return {
        campaignId: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        brief: c.brief
          ? {
              version: c.brief.version,
              confirmedByUser: c.brief.confirmedByUser,
              rules: c.brief.data,
            }
          : null,
        assets: c.assets.slice(0, a.limit).map((x: any) => ({
          assetId: x.id,
          type: x.type,
          name: x.fileName,
          label: x.label,
          required: x.required,
          intendedUse: x.intendedUse,
        })),
        sources: c.sources.slice(0, a.limit).map((x: any) => ({
          campaignSourceId: x.id,
          sourceId: x.videoId,
          name: x.video.originalName,
          duration: x.video.duration,
          status: x.video.processingJobs[0]?.status || "UNAVAILABLE",
        })),
        runs: c.runs.slice(0, a.limit).map((r: any) => ({
          jobId: "g:" + r.id,
          status: r.status,
          mode: r.mode,
          style: r.style,
        })),
        clips: c.clips.slice(0, a.limit).map((x: any) => ({
          campaignClipId: x.id,
          editProjectId: x.editProjectId,
          complianceStatus: x.complianceStatus,
          status: x.lifecycleStatus,
          title: x.title,
        })),
        nextOffset: [c.assets, c.sources, c.runs, c.clips].some(
          (x: any[]) => x.length > a.limit,
        )
          ? a.offset + a.limit
          : null,
      };
    }
    if (tool === "create_campaign") {
      const c = await this.campaigns.create({
        name: a.name,
        description: a.description || "",
        sourceText: a.rules || "",
        platforms: a.platforms,
      });
      return { campaignId: c.id, status: "DRAFT" };
    }
    if (tool === "understand_campaign") {
      const r = await this.campaigns.understand(a.campaignId, {
        version: a.expectedBriefVersion,
        sourceText: a.rules,
        mode: a.mode,
      });
      return {
        campaignId: a.campaignId,
        briefVersion: r.brief.version,
        status: "NEEDS_CONFIRMATION",
      };
    }
    if (tool === "confirm_campaign") {
      const r = await this.campaigns.confirm(a.campaignId, {
        version: a.briefVersion,
        confirmedByUser: true,
        warningsAcknowledged: a.acknowledgeUnresolved,
      });
      return {
        campaignId: a.campaignId,
        briefVersion: r?.version,
        confirmed: true,
      };
    }
    if (tool === "attach_campaign_source") {
      const r = await this.campaigns.source(a.campaignId, {
        videoId: a.sourceId,
        authorized: a.rightsConfirmed,
      });
      return {
        campaignId: a.campaignId,
        campaignSourceId: r.id,
        sourceId: r.videoId,
      };
    }
    if (tool === "generate_campaign_clips") {
      const rows = await this.campaigns.generate(a.campaignId, {
        sourceIds: a.campaignSourceIds,
        mode: a.mode,
        style: quickStyles[a.style as keyof typeof quickStyles],
        count: a.clipCount,
        notes: a.instruction || "",
        requestKey: requestIdentity.getStore()!.operationId,
      });
      return {
        jobId: "g:" + rows[0].id,
        jobIds: rows.map((r) => "g:" + r.id),
        status: "QUEUED",
        recommendedPollAfterMs: 5000,
      };
    }
    if (tool === "get_campaign_clip_compliance") {
      const r = await this.campaigns.checkClip(
        a.campaignClipId,
        false,
        0,
        false,
      );
      return {
        campaignClipId: a.campaignClipId,
        compliance: r.compliance,
        revision: r.checkedRevision,
        briefVersion: r.checkedBriefVersion,
      };
    }
    if (tool === "list_history") {
      const before = a.cursor
        ? await this.videos.historyCursor(a.cursor)
        : undefined;
      const params = { limit: a.limit + 1, before, beforeId: a.cursor };
      const [clips, quick] = await Promise.all([
        this.videos.getHistory(params),
        this.quick.history(params),
      ]);
      const entries = [
        ...clips.map((c) => ({
          id: c.id,
          kind: "CLIP",
          title: c.title,
          createdAt: c.createdAt,
          style: c.style,
          mode: c.mode,
          editorUrl: c.editUrl ? website(c.editUrl) : null,
        })),
        ...quick.map((q) => ({
          id: q.id,
          kind: "QUICK_REFRAME",
          title: q.name,
          createdAt: q.createdAt,
          style: q.styleTwoApplied
            ? "STYLE_TWO"
            : q.styleOneApplied
              ? "STYLE_ONE"
              : q.styleZeroApplied
                ? "STYLE_ZERO"
                : null,
          mode: q.mode,
          resultUrl: website("/quick-reframe?video=" + q.id + "&step=result"),
          editorUrl: website("/edit-mode/" + q.editProjectId),
        })),
      ];
      entries.sort(
        (a, b) =>
          Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)) ||
          b.id.localeCompare(a.id),
      );
      return page(entries, a.limit, (v) => v.id);
    }
    if (tool === "restore_edit_project") {
      const p = await this.materializer.materialize(a.clipId);
      return {
        clipId: a.clipId,
        editProjectId: p.editProjectId,
        websiteUrl: website("/edit-mode/" + p.editProjectId),
      };
    }
    if (tool === "get_edit_project") {
      if ((!a.editProjectId && !a.clipId) || (a.editProjectId && a.clipId))
        throw new McpToolError(
          "INVALID_INPUT",
          "Supply editProjectId or clipId.",
        );
      if (a.clipId) {
        const clip = await this.videos.clipSummary(a.clipId);
        if (clip.editProjectId) a.editProjectId = clip.editProjectId;
        else
          return {
            clipId: a.clipId,
            editProjectId: null,
            restorationRequired: true,
            nextTool: "xeeclip_restore_edit_project",
          };
      }
      return this.projectSummary(await this.edit.get(a.editProjectId));
    }
    if (tool === "get_export") {
      const current = await this.render.progress(a.editProjectId);
      if (a.exportId && current?.exportId !== a.exportId) {
        const old = await this.render.exportForOperation(
          a.editProjectId,
          a.exportId,
        );
        if (!old) throw new McpToolError("NOT_FOUND", "Export not found.");
        return {
          exportId: a.exportId,
          status: "COMPLETE",
          assetId: old.id,
          downloadUrl: new URL(
            "/mcp/exports/" + a.editProjectId + "/" + a.exportId + "/file",
            mcpConfig().issuer,
          ).href,
          authenticationRequired: true,
          resultUrl: website("/edit-mode/" + a.editProjectId),
          downloadAuthentication:
            "Use this connection’s MCP OAuth Bearer token in the Authorization header. No browser login or session cookie is required. resultUrl is optional human UI only.",
        };
      }
      if (!current)
        throw new McpToolError("NOT_FOUND", "No export has started.");
      const complete = current.phase === "COMPLETED";
      return {
        editProjectId: a.editProjectId,
        exportId: current.exportId,
        status: complete
          ? "COMPLETE"
          : current.phase === "FAILED"
            ? "FAILED"
            : current.phase === "PREPARING"
              ? "QUEUED"
              : "PROCESSING",
        progress: current.percent,
        revision: current.sourceRevision,
        errorCode: current.phase === "FAILED" ? "EXPORT_FAILED" : null,
        downloadUrl:
          complete && current.assetId
            ? new URL(
                "/mcp/exports/" +
                  a.editProjectId +
                  "/" +
                  current.exportId +
                  "/file",
                mcpConfig().issuer,
              ).href
            : null,
        authenticationRequired: true,
        resultUrl: website("/edit-mode/" + a.editProjectId),
        downloadAuthentication:
          "Use this connection’s MCP OAuth Bearer token in the Authorization header. No browser login or session cookie is required. resultUrl is optional human UI only.",
        recommendedPollAfterMs: 5000,
      };
    }
    const p = await this.edit.get(a.editProjectId);
    if (p.revision !== a.expectedRevision)
      throw new McpToolError(
        "EDIT_CONFLICT",
        "Read the current project revision.",
      );
    if (tool === "save_edit")
      return { editProjectId: p.id, revision: p.revision, saved: true };
    if (tool === "export_clip") {
      const r = await this.render.startExport(p.id, a.expectedRevision);
      return {
        editProjectId: p.id,
        exportId: r.export.exportId,
        status: "QUEUED",
        recommendedPollAfterMs: 5000,
      };
    }
    if (tool === "undo" || tool === "redo") {
      const r = await this.edit[tool](p.id, a.expectedRevision);
      return { editProjectId: p.id, revision: r.revision, saved: true };
    }
    if (tool === "trim_video") {
      const e = this.target(p, "VIDEO", a.elementId);
      const r = await this.edit.trimElement(p.id, {
        revision: a.expectedRevision,
        elementId: e.id,
        trimStart: a.start,
        trimEnd: a.end,
      });
      return { editProjectId: p.id, revision: r.revision, saved: true };
    }
    const command = (
      action: string,
      payload: Record<string, unknown>,
    ): AssistantBundleCommand => ({ kind: "ELEMENT", action, payload });
    const selectedVideo = () => this.target(p, "VIDEO", a.elementId).id;
    const commands: AssistantBundleCommand[] = [];
    let rev = p.revision;
    if (tool === "set_crop")
      commands.push(
        command("SET_VIDEO_CROP", {
          elementId: selectedVideo(),
          cropLeft: a.crop.left,
          cropRight: a.crop.right,
          cropTop: a.crop.top,
          cropBottom: a.crop.bottom,
        }),
      );
    else if (tool === "set_zoom")
      commands.push(
        command("SET_VIDEO_SCALE", {
          elementId: selectedVideo(),
          scale: a.scale,
        }),
      );
    else if (tool === "set_pan")
      commands.push(
        command("SET_VIDEO_POSITION", {
          elementId: selectedVideo(),
          x: a.x,
          y: a.y,
        }),
      );
    else if (tool === "update_headline") {
      const e = this.target(p, "TEXT", a.elementId);
      if (a.box) {
        if (
          a.box.x + a.box.width > 1 + 1e-6 ||
          a.box.y + a.box.height > 1 + 1e-6
        )
          throw new McpToolError(
            "EDIT_VALIDATION_FAILED",
            "The headline box must fit within the canvas.",
          );
        commands.push(
          command("MOVE_ELEMENT", { elementId: e.id, x: a.box.x, y: a.box.y }),
          command("RESIZE_ELEMENT", {
            elementId: e.id,
            width: a.box.width,
            height: a.box.height,
          }),
        );
      }
      if (a.color !== undefined)
        commands.push(
          command("SET_TEXT_COLOR", { elementId: e.id, color: a.color }),
        );
      if (a.fontSize !== undefined)
        commands.push(
          command("SET_TEXT_SIZE", { elementId: e.id, fontSize: a.fontSize }),
        );
      if (a.textAlign !== undefined)
        commands.push(
          command("SET_TEXT_ALIGNMENT", {
            elementId: e.id,
            textAlign: a.textAlign,
          }),
        );
      if (a.stroke)
        commands.push(
          command("SET_TEXT_STROKE", {
            elementId: e.id,
            strokeEnabled: a.stroke.enabled,
            strokeColor: a.stroke.color,
            strokeWidth: a.stroke.width,
          }),
        );
      if (a.shadow)
        commands.push(
          command("SET_TEXT_SHADOW", {
            elementId: e.id,
            shadowEnabled: a.shadow.enabled,
            shadowColor: a.shadow.color,
            shadowOpacity: a.shadow.opacity,
            shadowBlur: a.shadow.blur,
            shadowOffsetX: a.shadow.offsetX,
            shadowOffsetY: a.shadow.offsetY,
          }),
        );
      if (a.background)
        commands.push(
          command("SET_TEXT_BACKGROUND", {
            elementId: e.id,
            backgroundEnabled: a.background.enabled,
            backgroundColor: a.background.color,
            backgroundOpacity: a.background.opacity,
            backgroundPadding: a.background.padding,
            backgroundRadius: a.background.radius,
          }),
        );
      commands.push(
        command("SET_TEXT_CONTENT", { elementId: e.id, content: a.text }),
      );
    } else if (tool === "update_caption") {
      const e = this.target(p, "SUBTITLE", a.captionElementId);
      if (a.text !== undefined)
        commands.push(
          command("SET_CAPTION_TEXT", { elementId: e.id, content: a.text }),
        );
      if (a.start !== undefined || a.end !== undefined) {
        const start = a.start ?? e.startTime,
          end = a.end ?? e.startTime + e.duration;
        commands.push(
          command("SET_ELEMENT_TIMING", {
            elementId: e.id,
            startTime: start,
            duration: end - start,
          }),
        );
      }
    } else if (tool === "set_caption_style")
      commands.push(
        command("SET_CAPTION_STYLE", {
          scope: "TRACK",
          elementType: "SUBTITLE",
          captionStyleId: a.preset,
        }),
      );
    else if (tool === "set_music_volume")
      commands.push(
        command("SET_AUDIO_VOLUME", { scope: "TRACK", volume: a.volume }),
      );
    else if (tool === "set_source_volume")
      commands.push(
        command("SET_SOURCE_AUDIO_VOLUME", {
          elementId: selectedVideo(),
          volume: a.volume,
        }),
      );
    else if (["add_image_overlay", "add_logo", "set_music"].includes(tool)) {
      const role =
        tool === "set_music" ? "AUDIO" : tool === "add_logo" ? "LOGO" : "IMAGE";
      const asset = await this.asset(p, a.asset, role, auth);
      rev = asset.revision;
      if (tool === "set_music") {
        const audio = p.elements.filter((e) => e.type === "AUDIO");
        if (!audio.length || !audio.every((e) => e.assetId === asset.assetId)) {
          for (const e of audio)
            commands.push(command("REMOVE_ELEMENT", { elementId: e.id }));
          commands.push(
            command("ADD_AUDIO", { assetId: asset.assetId, startTime: 0 }),
          );
        }
        commands.push(
          command("SET_AUDIO_VOLUME", { scope: "TRACK", volume: a.volume }),
        );
      } else
        commands.push(
          command(tool === "add_logo" ? "ADD_LOGO" : "ADD_IMAGE", {
            assetId: asset.assetId,
          }),
        );
    } else if (tool === "update_overlay" || tool === "remove_overlay") {
      const ids =
        tool === "remove_overlay"
          ? a.elementIds || [a.elementId]
          : [a.elementId];
      if (
        tool === "remove_overlay" &&
        (!!a.elementId === !!a.elementIds || new Set(ids).size !== ids.length)
      )
        throw new McpToolError(
          "INVALID_INPUT",
          "Choose elementId or unique elementIds.",
        );
      const layers = ids.map((id: string) => {
        const e = p.elements.find((x: any) => x.id === id);
        if (!e) throw new McpToolError("NOT_FOUND", "Element not found.");
        if (!["TEXT", "SUBTITLE", "IMAGE"].includes(e.type))
          throw new McpToolError(
            "UNSUPPORTED_OPERATION",
            "Only editable text, captions and image layers are supported.",
          );
        return e;
      });
      if (tool === "remove_overlay")
        for (const e of layers)
          commands.push(command("REMOVE_ELEMENT", { elementId: e.id }));
      else {
        const e = layers[0];
        if (a.x !== undefined || a.y !== undefined)
          commands.push(
            command("MOVE_ELEMENT", {
              elementId: e.id,
              x: a.x ?? object(e.properties).x,
              y: a.y ?? object(e.properties).y,
            }),
          );
        if (a.width !== undefined || a.height !== undefined)
          commands.push(
            command("RESIZE_ELEMENT", {
              elementId: e.id,
              width: a.width ?? object(e.properties).width,
              height: a.height ?? object(e.properties).height,
            }),
          );
        if (a.opacity !== undefined)
          commands.push(
            command("SET_ELEMENT_OPACITY", {
              elementId: e.id,
              opacity: a.opacity,
            }),
          );
      }
    } else if (tool === "set_filter")
      commands.push(
        command("APPLY_COLOR_FILTER", {
          elementId: selectedVideo(),
          filterId: a.preset,
          strength: a.strength,
        }),
      );
    else if (tool === "set_visual_adjustments") {
      const elementId = selectedVideo();
      for (const [field, value] of Object.entries(a.adjustments))
        commands.push(
          command("SET_VIDEO_" + field.toUpperCase(), {
            elementId,
            [field]: value,
          }),
        );
    } else throw new McpToolError("UNSUPPORTED_OPERATION", "Unsupported tool.");
    return this.bundle(p.id, rev, commands);
  }
}
