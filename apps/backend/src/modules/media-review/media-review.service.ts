import { checkpointOperation } from "../auth/operation-checkpoint";
import { Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { PrismaService } from "../database/prisma.service";
import { StorageService } from "../storage/storage.service";
import { resolveMediaByteRange } from "../edit-mode/edit-mode.service";
import {
  REVIEW_SCOPE,
  REVIEW_TTL,
  REQUEST_TTL,
  VideoReviewError,
  equalSignature,
  reviewSign,
} from "./media-review.policy";
import { mcpConfig } from "../mcp/mcp-config";

type Media = {
  kind: string;
  id: string;
  bucket: string;
  key: string;
  size: number;
  duration: number;
  fingerprint: string;
  projectId: string | null;
};
function fail(code: string): never {
  throw new VideoReviewError(code);
}
@Injectable()
export class MediaReviewService implements OnModuleDestroy {
  private streams = new Map<string, Set<Readable>>();
  private openingStreams = new Set<string>();
  private timer = setInterval(() => void this.checkStreams(), 1000);
  private expiryTimer = setInterval(
    () => void this.expire().catch(() => undefined),
    30000,
  );
  constructor(
    private readonly prisma: PrismaService,
    readonly storage: StorageService,
  ) {
    this.timer.unref();
    this.expiryTimer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    clearInterval(this.expiryTimer);
    for (const id of this.streams.keys()) this.closeStreams(id);
  }
  private async audit(
    request: { id: string; userId: string; clientId: string; clipId: string },
    event: string,
    db: any = this.prisma,
  ) {
    await db.aiVideoReviewAudit.create({
      data: {
        userId: request.userId,
        clientId: request.clientId,
        clipId: request.clipId,
        reviewRequestId: request.id,
        event,
      },
    });
  }
  async enabled(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiVideoReviewEnabled: true, status: true },
    });
    if (!user || user.status !== "ACTIVE")
      throw new NotFoundException("Review not found.");
    if (!user.aiVideoReviewEnabled) fail("AI_VIDEO_REVIEW_DISABLED");
  }
  private async connection(
    userId: string,
    clientId: string,
    connectionId: string,
  ) {
    const connection = await this.prisma.mcpGrant.findFirst({
      where: {
        id: connectionId,
        userId,
        clientId,
        revokedAt: null,
        scopes: { has: REVIEW_SCOPE },
      },
    });
    if (!connection) fail("AI_VIDEO_REVIEW_REVOKED");
  }
  private identity(auth: AuthInfo) {
    const userId = auth.extra?.userId,
      connectionId = auth.extra?.connectionId;
    if (
      typeof userId !== "string" ||
      typeof connectionId !== "string" ||
      !auth.scopes.includes(REVIEW_SCOPE)
    )
      throw new NotFoundException("Review not found.");
    return { userId, clientId: auth.clientId, connectionId };
  }
  // Only rendered output records qualify. SOURCE, uploaded media and arbitrary URLs never do.
  async media(kind: string, id: string, userId: string): Promise<Media> {
    let row: any;
    if (kind === "GENERATED_CLIP")
      row = await this.prisma.generatedClip.findFirst({
        where: { id, video: { project: { userId } } },
        select: {
          id: true,
          bucket: true,
          objectKey: true,
          mimeType: true,
          sizeBytes: true,
          duration: true,
        },
      });
    else if (kind === "EXPORT")
      row = await this.prisma.editAsset.findFirst({
        where: {
          id,
          role: "EXPORT",
          storageOwnership: "OWNED",
          editProject: { userId },
        },
        select: {
          id: true,
          editProjectId: true,
          bucket: true,
          objectKey: true,
          storageObjectKey: true,
          mimeType: true,
          sizeBytes: true,
          duration: true,
        },
      });
    if (!row || row.mimeType !== "video/mp4")
      throw new NotFoundException("Rendered video not found.");
    const key = row.storageObjectKey || row.objectKey,
      stat = await this.storage.statObject(row.bucket, key).catch(() => null);
    if (!stat || !stat.size || stat.size !== Number(row.sizeBytes))
      fail("AI_VIDEO_REVIEW_NOT_READY");
    const duration = Number(row.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      fail("AI_VIDEO_REVIEW_NOT_READY");
    const fingerprint = createHash("sha256")
      .update([kind, id, stat.etag, stat.size].join(":"))
      .digest("hex");
    return {
      kind,
      id,
      bucket: row.bucket,
      key,
      size: stat.size,
      duration,
      fingerprint,
      projectId: row.editProjectId || null,
    };
  }
  async resolve(clipId: string, userId: string): Promise<Media> {
    const clip = await this.prisma.generatedClip.findFirst({
      where: { id: clipId, video: { project: { userId } } },
      select: { id: true, editProject: { select: { id: true } } },
    });
    let projectId = clip?.editProject?.id;
    let generatedId = clip?.id;
    if (!clip) {
      const quick = await this.prisma.quickReframe.findFirst({
        where: { id: clipId, editProject: { userId } },
        select: { editProjectId: true },
      });
      const project = quick
        ? null
        : await this.prisma.editProject.findFirst({
            where: { id: clipId, userId },
            select: { id: true, generatedClipId: true },
          });
      projectId = quick?.editProjectId || project?.id;
      generatedId = project?.generatedClipId || undefined;
      if (!projectId) throw new NotFoundException("Rendered video not found.");
    }
    if (projectId) {
      const asset = await this.prisma.editAsset.findFirst({
        where: {
          editProjectId: projectId,
          role: "EXPORT",
          editProject: { userId },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (asset) return this.media("EXPORT", asset.id, userId);
    }
    if (generatedId)
      return {
        ...(await this.media("GENERATED_CLIP", generatedId, userId)),
        projectId: projectId || null,
      };
    return fail("AI_VIDEO_REVIEW_NOT_READY");
  }
  async request(auth: AuthInfo, clipId: string, purpose: string) {
    const identity = this.identity(auth);
    await this.enabled(identity.userId);
    await this.connection(
      identity.userId,
      identity.clientId,
      identity.connectionId,
    );
    const media = await this.resolve(clipId, identity.userId);
    const request = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${identity.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: identity.userId },
        select: { aiVideoReviewEnabled: true },
      });
      if (!user?.aiVideoReviewEnabled) fail("AI_VIDEO_REVIEW_DISABLED");
      const request = await tx.aiVideoReviewRequest.create({
        data: {
          ...identity,
          clipId,
          purpose,
          mediaKind: media.kind,
          mediaId: media.id,
          renderFingerprint: media.fingerprint,
          projectId: media.projectId,
          expiresAt: new Date(Date.now() + REQUEST_TTL),
        },
      });
      await this.audit(request, "REQUESTED", tx);
      await checkpointOperation(tx, this.requestResult(request.id), request.id);
      return request;
    });
    return this.requestResult(request.id);
  }
  private requestResult(id: string) {
    return {
      reviewRequestId: id,
      status: "AWAITING_USER_APPROVAL",
      approvalUrl: new URL("/settings?review=" + id, mcpConfig().frontend).href,
    };
  }
  async requestFromWebsite(
    userId: string,
    clipId: string,
    connectionId: string,
  ) {
    const connection = await this.prisma.mcpGrant.findFirst({
      where: {
        id: connectionId,
        userId,
        revokedAt: null,
        scopes: { has: REVIEW_SCOPE },
      },
    });
    if (!connection)
      throw new NotFoundException(
        "Connect an assistant with video review permission first.",
      );
    return this.request(
      {
        token: "",
        clientId: connection.clientId,
        scopes: [REVIEW_SCOPE],
        extra: { userId, connectionId },
      },
      clipId,
      "Check this rendered video's visual and audio editing quality.",
    );
  }
  private nonce(request: { id: string; userId: string; expiresAt: Date }) {
    return reviewSign(
      [
        "approval",
        request.id,
        request.userId,
        request.expiresAt.getTime(),
      ].join(":"),
    );
  }
  async consent(id: string, userId: string) {
    await this.expire(userId);
    const request = await this.prisma.aiVideoReviewRequest.findFirst({
      where: { id, userId },
    });
    if (!request) throw new NotFoundException("Review request not found.");
    const client = await this.prisma.mcpClient.findUnique({
      where: { id: request.clientId },
      select: { name: true },
    });
    return {
      reviewRequestId: id,
      clipId: request.clipId,
      clientName: client?.name || "Disconnected assistant",
      purpose: request.purpose,
      status: request.status,
      expiresAt: request.expiresAt,
      nonce:
        request.status === "PENDING_USER_APPROVAL" ? this.nonce(request) : null,
    };
  }
  async decide(
    id: string,
    userId: string,
    nonce: string,
    approve: boolean,
    allowRevisions: boolean,
  ) {
    await this.enabled(userId);
    const request = await this.prisma.aiVideoReviewRequest.findFirst({
      where: { id, userId },
    });
    if (!request || !equalSignature(nonce, this.nonce(request)))
      throw new NotFoundException("Review request not found.");
    if (request.expiresAt.getTime() <= Date.now())
      fail("AI_VIDEO_REVIEW_EXPIRED");
    await this.connection(userId, request.clientId, request.connectionId);
    if (approve) {
      const media = await this.media(
        request.mediaKind,
        request.mediaId,
        userId,
      );
      if (media.fingerprint !== request.renderFingerprint)
        fail("AI_VIDEO_REVIEW_CHANGED");
    }
    return this.prisma.$transaction(async (tx) => {
      // Serializes OFF with approval. A disabled setting cannot leave an active grant behind.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { aiVideoReviewEnabled: true },
      });
      if (!user?.aiVideoReviewEnabled) fail("AI_VIDEO_REVIEW_DISABLED");
      const now = new Date(),
        expiresAt = new Date(now.getTime() + REVIEW_TTL);
      const claimed = await tx.aiVideoReviewRequest.updateMany({
        where: {
          id,
          userId,
          status: "PENDING_USER_APPROVAL",
          expiresAt: { gt: now },
        },
        data: {
          status: approve ? "APPROVED" : "DENIED",
          decidedAt: now,
          ...(approve ? { expiresAt } : {}),
        },
      });
      if (!claimed.count) fail("AI_VIDEO_REVIEW_APPROVAL_REQUIRED");
      if (approve)
        await tx.aiVideoReviewGrant.create({
          data: {
            userId,
            clipId: request.clipId,
            clientId: request.clientId,
            reviewRequestId: id,
            expiresAt,
            allowRevisions,
            maxPasses: allowRevisions ? 3 : 1,
          },
        });
      await this.audit(request, approve ? "APPROVED" : "DENIED", tx);
      return { reviewRequestId: id, status: approve ? "APPROVED" : "DENIED" };
    });
  }
  async pendingCount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiVideoReviewEnabled: true },
    });
    return {
      count: user?.aiVideoReviewEnabled
        ? await this.prisma.aiVideoReviewRequest.count({
            where: {
              userId,
              status: "PENDING_USER_APPROVAL",
              expiresAt: { gt: new Date() },
            },
          })
        : 0,
    };
  }
  async settings(userId: string) {
    await this.expire(userId);
    const [user, requests, clients, connections] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { aiVideoReviewEnabled: true },
      }),
      this.prisma.aiVideoReviewRequest.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          grant: {
            include: {
              passes: {
                orderBy: { createdAt: "desc" },
                select: {
                  id: true,
                  status: true,
                  verdict: true,
                  evidenceType: true,
                  coverage: true,
                  findings: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.mcpClient.findMany({
        where: { grants: { some: { userId } } },
        select: { id: true, name: true },
      }),
      this.prisma.mcpGrant.findMany({
        where: { userId, revokedAt: null, scopes: { has: REVIEW_SCOPE } },
        select: { id: true, clientId: true },
      }),
    ]);
    const names = new Map(clients.map((c) => [c.id, c.name]));
    return {
      enabled: user.aiVideoReviewEnabled,
      connections: connections.map((c) => ({
        id: c.id,
        name: names.get(c.clientId) || "Assistant",
      })),
      requests: requests.map((r) => ({
        reviewRequestId: r.id,
        clipId: r.clipId,
        clientName: names.get(r.clientId) || "Disconnected assistant",
        purpose: r.purpose,
        status: r.status,
        expiresAt: r.expiresAt,
        allowRevisions: r.grant?.allowRevisions || false,
        editorUrl: r.projectId ? "/edit-mode/" + r.projectId : null,
        passes: r.grant?.passes || [],
      })),
    };
  }
  async setEnabled(userId: string, enabled: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      await tx.user.update({
        where: { id: userId },
        data: { aiVideoReviewEnabled: enabled },
      });
      if (!enabled) {
        const requests = await tx.aiVideoReviewRequest.findMany({
          where: {
            userId,
            status: {
              in: ["PENDING_USER_APPROVAL", "APPROVED", "REVIEWING", "FAILED"],
            },
          },
        });
        await tx.aiVideoReviewGrant.updateMany({
          where: { userId, status: "APPROVED" },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
        await tx.aiVideoReviewRequest.updateMany({
          where: { id: { in: requests.map((r) => r.id) } },
          data: { status: "REVOKED" },
        });
        for (const r of requests) await this.audit(r, "REVOKED", tx);
      }
    });
    if (!enabled) await this.checkStreams();
    return { enabled };
  }
  async revoke(id: string, userId: string) {
    const r = await this.prisma.aiVideoReviewRequest.findFirst({
      where: { id, userId },
      include: { grant: true },
    });
    if (!r) throw new NotFoundException("Review not found.");
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      await tx.aiVideoReviewRequest.update({
        where: { id },
        data: { status: "REVOKED" },
      });
      await tx.aiVideoReviewGrant.updateMany({
        where: { reviewRequestId: id, userId },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await this.audit(r, "REVOKED", tx);
    });
    if (r.grant) this.closeStreams(r.grant.id);
    return { revoked: true };
  }
  async expire(userId?: string) {
    const now = new Date(),
      where = {
        ...(userId ? { userId } : {}),
        expiresAt: { lte: now },
        status: {
          in: ["PENDING_USER_APPROVAL", "APPROVED", "REVIEWING", "FAILED"],
        },
      };
    const requests = await this.prisma.aiVideoReviewRequest.findMany({
      where,
      take: 100,
    });
    for (const r of requests) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${r.userId} FOR UPDATE`;
        const changed = await tx.aiVideoReviewRequest.updateMany({
          where: { id: r.id, ...where },
          data: { status: "EXPIRED" },
        });
        if (changed.count) {
          await tx.aiVideoReviewGrant.updateMany({
            where: { reviewRequestId: r.id },
            data: { status: "EXPIRED" },
          });
          await this.audit(r, "EXPIRED", tx);
        }
      });
    }
  }
  async authorized(auth: AuthInfo, id: string) {
    const who = this.identity(auth);
    await this.enabled(who.userId);
    await this.expire(who.userId);
    const r = await this.prisma.aiVideoReviewRequest.findFirst({
      where: {
        id,
        userId: who.userId,
        clientId: who.clientId,
        connectionId: who.connectionId,
      },
      include: { grant: true },
    });
    if (!r) throw new NotFoundException("Review not found.");
    await this.connection(who.userId, who.clientId, who.connectionId);
    if (r.status === "DENIED") fail("AI_VIDEO_REVIEW_DENIED");
    if (r.status === "EXPIRED" || r.expiresAt.getTime() <= Date.now())
      fail("AI_VIDEO_REVIEW_EXPIRED");
    if (r.status === "REVOKED" || r.grant?.revokedAt)
      fail("AI_VIDEO_REVIEW_REVOKED");
    if (r.status === "COMPLETE" || r.grant?.consumedAt)
      fail("AI_VIDEO_REVIEW_COMPLETE");
    if (
      r.grant &&
      (r.grant.userId !== who.userId ||
        r.grant.clientId !== who.clientId ||
        r.grant.clipId !== r.clipId)
    )
      throw new NotFoundException("Review not found.");
    if (r.grant && r.grant.expiresAt.getTime() <= Date.now())
      fail("AI_VIDEO_REVIEW_EXPIRED");
    if (
      !r.grant ||
      r.grant.status !== "APPROVED" ||
      r.grant.scope !== "REVIEW_MEDIA_ONLY"
    )
      fail("AI_VIDEO_REVIEW_APPROVAL_REQUIRED");
    return r as typeof r & { grant: NonNullable<typeof r.grant> };
  }
  async pass(auth: AuthInfo, id: string) {
    const r = await this.authorized(auth, id),
      media = await this.resolve(r.clipId, r.userId);
    if (!r.grant.allowRevisions && media.fingerprint !== r.renderFingerprint)
      fail("AI_VIDEO_REVIEW_CHANGED");
    const pass = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${r.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AiVideoReviewGrant" WHERE id = ${r.grant.id} FOR UPDATE`;
      const [current, user] = await Promise.all([
        tx.aiVideoReviewGrant.findUnique({ where: { id: r.grant.id } }),
        tx.user.findUnique({
          where: { id: r.userId },
          select: { aiVideoReviewEnabled: true },
        }),
      ]);
      if (!user?.aiVideoReviewEnabled) fail("AI_VIDEO_REVIEW_DISABLED");
      if (
        !current ||
        current.status !== "APPROVED" ||
        current.revokedAt ||
        current.expiresAt.getTime() <= Date.now()
      )
        fail("AI_VIDEO_REVIEW_REVOKED");
      const old = await tx.aiVideoReviewPass.findUnique({
        where: {
          grantId_renderFingerprint: {
            grantId: r.grant.id,
            renderFingerprint: media.fingerprint,
          },
        },
      });
      if (old) {
        if (old.status === "COMPLETE") fail("AI_VIDEO_REVIEW_PASS_COMPLETE");
        return old;
      }
      if (
        (await tx.aiVideoReviewPass.count({
          where: { grantId: r.grant.id },
        })) >= r.grant.maxPasses
      )
        fail("AI_VIDEO_REVIEW_LIMIT");
      return tx.aiVideoReviewPass.create({
        data: {
          grantId: r.grant.id,
          renderFingerprint: media.fingerprint,
          mediaKind: media.kind,
          mediaId: media.id,
          duration: media.duration,
        },
      });
    });
    return { request: r, pass, media };
  }
  async approvedRequests(auth: AuthInfo) {
    const who = this.identity(auth);
    await this.enabled(who.userId);
    await this.connection(who.userId, who.clientId, who.connectionId);
    await this.expire(who.userId);
    const rows = await this.prisma.aiVideoReviewRequest.findMany({
      where: {
        ...who,
        status: { in: ["APPROVED", "REVIEWING"] },
        expiresAt: { gt: new Date() },
        grant: {
          is: {
            status: "APPROVED",
            revokedAt: null,
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
        },
      },
      select: { id: true, purpose: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return {
      reviews: rows.map((r) => ({
        reviewRequestId: r.id,
        purpose: r.purpose,
        expiresAt: r.expiresAt,
      })),
    };
  }
  async getMedia(auth: AuthInfo, id: string) {
    const { request: r, pass, media } = await this.pass(auth, id);
    await this.authorized(auth, id);
    const expires = Math.min(r.grant.expiresAt.getTime(), Date.now() + 120000);
    const payload = [
        id,
        pass.id,
        media.fingerprint,
        auth.clientId,
        expires,
      ].join(":"),
      ticket = expires + "." + reviewSign(payload);
    return {
      reviewUrl: new URL(
        `/mcp/review-media/${id}/${pass.id}?ticket=${ticket}`,
        mcpConfig().issuer,
      ).href,
      mimeType: "video/mp4",
      duration: media.duration,
      expiresAt: new Date(expires).toISOString(),
      reviewPassId: pass.id,
      authorization: "MCP_BEARER_REQUIRED",
      evidenceType: "METADATA_ONLY",
      nextStep:
        "Use xeeclip_review_video to receive actual rendered frames and audio without browser login. A URL alone is not evidence of inspection.",
    };
  }
  async stream(
    auth: AuthInfo,
    id: string,
    passId: string,
    ticket: string,
    range?: string,
  ) {
    const r = await this.authorized(auth, id),
      p = await this.prisma.aiVideoReviewPass.findFirst({
        where: { id: passId, grantId: r.grant.id },
      });
    if (!p) throw new NotFoundException("Review not found.");
    if (p.status === "COMPLETE") fail("AI_VIDEO_REVIEW_PASS_COMPLETE");
    if (!/^\d{13}\.[A-Za-z0-9_-]{43}$/.test(ticket))
      fail("AI_VIDEO_REVIEW_EXPIRED");
    const [expiresText, signature] = ticket.split("."),
      expires = Number(expiresText);
    if (
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      expires > r.grant.expiresAt.getTime() ||
      !equalSignature(
        signature,
        reviewSign(
          [id, passId, p.renderFingerprint, auth.clientId, expires].join(":"),
        ),
      )
    )
      fail("AI_VIDEO_REVIEW_EXPIRED");
    const media = await this.media(p.mediaKind, p.mediaId, r.userId);
    if (media.fingerprint !== p.renderFingerprint)
      fail("AI_VIDEO_REVIEW_CHANGED");
    const claimed = await this.prisma.aiVideoReviewPass.updateMany({
      where: {
        id: p.id,
        status: { not: "COMPLETE" },
        evidenceCalls: { lt: 5 },
        OR: [{ lockUntil: null }, { lockUntil: { lt: new Date() } }],
      },
      data: { evidenceCalls: { increment: 1 } },
    });
    if (!claimed.count) {
      const current = await this.prisma.aiVideoReviewPass.findUnique({
        where: { id: p.id },
        select: { evidenceCalls: true, status: true },
      });
      fail(
        current?.status === "COMPLETE"
          ? "AI_VIDEO_REVIEW_PASS_COMPLETE"
          : current && current.evidenceCalls >= 5
            ? "AI_VIDEO_REVIEW_LIMIT"
            : "AI_VIDEO_REVIEW_BUSY",
      );
    }
    const file = await this.openReviewStream(
      media,
      r.grant.id,
      r.grant.expiresAt,
    );
    try {
      await this.authorized(auth, id);
    } catch (error) {
      file.stream.destroy();
      throw error;
    }
    try {
      await this.audit(r, "ACCESSED");
    } catch (error) {
      file.stream.destroy();
      throw error;
    }
    return {
      ...file,
      onDelivered: async () => {
        const coverage = Array.isArray(p.coverage) ? p.coverage : [];
        await this.markAccess(r, p.id, [
          ...coverage,
          {
            start: 0,
            end: media.duration,
            delivery: "FULL_RENDERED_AV_STREAM",
            audio: "RENDERED_AUDIO_IF_PRESENT",
          },
        ]);
      },
    };
  }
  private async openReviewStream(media: Media, grantId: string, expires: Date) {
    // Review delivers only rendered A/V: no global tags, chapters, subtitle/data
    // tracks or hidden H.264 SEI captions/user data. Encoded A/V is not re-rendered.
    if (
      this.streams.size + this.openingStreams.size >= 2 ||
      this.openingStreams.has(grantId) ||
      this.streams.get(grantId)?.size
    )
      fail("AI_VIDEO_REVIEW_BUSY");
    this.openingStreams.add(grantId);
    try {
      const url = await this.storage.presignedGetUrl(
        media.bucket,
        media.key,
        Math.max(1, Math.ceil((expires.getTime() - Date.now()) / 1000)),
      );
      const probe = await new Promise<Buffer>((resolve, reject) =>
        execFile(
          "ffprobe",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "http,https,tcp,tls,crypto",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "json",
            url,
          ],
          {
            encoding: "buffer",
            timeout: 8000,
            maxBuffer: 16384,
            windowsHide: true,
          },
          (error, stdout) =>
            error
              ? reject(new VideoReviewError("AI_VIDEO_REVIEW_FAILED"))
              : resolve(stdout),
        ),
      );
      if (
        JSON.parse(probe.toString("utf8")).streams?.[0]?.codec_name !== "h264"
      )
        fail("AI_VIDEO_REVIEW_NOT_READY");
      const child = spawn(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "http,https,tcp,tls,crypto",
          "-i",
          url,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-sn",
          "-dn",
          "-c",
          "copy",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-bsf:v",
          "filter_units=remove_types=6",
          "-fflags",
          "+bitexact",
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof",
          "-f",
          "mp4",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      const stream = child.stdout;
      const timer = setTimeout(
        () => {
          stream.destroy();
          child.kill("SIGKILL");
        },
        Math.max(1, expires.getTime() - Date.now()),
      );
      timer.unref();
      stream.once("close", () => {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      child.once("error", () => stream.destroy());
      child.once("exit", (code) => {
        if (code && code !== 0) stream.destroy();
      });
      this.track(grantId, stream, expires);
      return { stream, mimeType: "video/mp4", streamOnly: true };
    } finally {
      this.openingStreams.delete(grantId);
    }
  }
  async preview(id: string, userId: string, range?: string) {
    const r = await this.prisma.aiVideoReviewRequest.findFirst({
      where: { id, userId },
    });
    if (!r) throw new NotFoundException("Review not found.");
    return this.open(await this.media(r.mediaKind, r.mediaId, userId), range);
  }
  private async open(media: Media, range?: string) {
    const bytes = resolveMediaByteRange(range, media.size);
    return {
      stream: bytes
        ? await this.storage.getPartialObject(
            media.bucket,
            media.key,
            bytes.start,
            bytes.end - bytes.start + 1,
          )
        : await this.storage.getObject(media.bucket, media.key),
      size: media.size,
      start: bytes?.start || 0,
      end: bytes?.end ?? media.size - 1,
      partial: !!bytes,
      mimeType: "video/mp4",
    };
  }
  async markAccess(
    r: { id: string; userId: string; clientId: string; clipId: string },
    passId: string,
    coverage: unknown[],
  ) {
    await this.prisma.aiVideoReviewPass.update({
      where: { id: passId },
      data: {
        accessedAt: new Date(),
        evidenceType: "ACTUAL_RENDERED_MEDIA",
        ...(coverage.length ? { coverage: coverage as any } : {}),
      },
    });
    await this.audit(r, "ACCESSED");
  }
  closeStreams(id: string) {
    for (const stream of this.streams.get(id) || []) stream.destroy();
    this.streams.delete(id);
  }
  private track(id: string, stream: Readable, expires: Date) {
    const streams = this.streams.get(id) || new Set();
    streams.add(stream);
    this.streams.set(id, streams);
    const timer = setTimeout(
      () => stream.destroy(),
      Math.max(1, expires.getTime() - Date.now()),
    );
    timer.unref();
    stream.once("close", () => {
      clearTimeout(timer);
      streams.delete(stream);
      if (!streams.size) this.streams.delete(id);
    });
  }
  private checking = false;
  private async checkStreams() {
    if (this.checking || !this.streams.size) return;
    this.checking = true;
    try {
      const rows = await this.prisma.aiVideoReviewGrant.findMany({
        where: { id: { in: [...this.streams.keys()] } },
        include: {
          user: { select: { aiVideoReviewEnabled: true, status: true } },
          request: { select: { connectionId: true } },
        },
      });
      const connections = await this.prisma.mcpGrant.findMany({
        where: {
          id: { in: rows.map((r) => r.request.connectionId) },
          revokedAt: null,
          scopes: { has: REVIEW_SCOPE },
        },
        select: { id: true },
      });
      const valid = new Set(
        rows
          .filter(
            (r) =>
              r.status === "APPROVED" &&
              !r.revokedAt &&
              !r.consumedAt &&
              r.expiresAt.getTime() > Date.now() &&
              r.user.aiVideoReviewEnabled &&
              r.user.status === "ACTIVE" &&
              connections.some((c) => c.id === r.request.connectionId),
          )
          .map((r) => r.id),
      );
      for (const id of this.streams.keys())
        if (!valid.has(id)) this.closeStreams(id);
    } catch {
      for (const id of this.streams.keys()) this.closeStreams(id);
    } finally {
      this.checking = false;
    }
  }
}
