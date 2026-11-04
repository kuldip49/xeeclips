import {
  VideoReviewError,
  reviewMessages,
} from "../media-review/media-review.policy";
import { createHash } from "node:crypto";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { PrismaService } from "../database/prisma.service";
import { requestIdentity } from "../auth/request-context";
import { ImportError } from "../videos/source-import-errors";
import { sourceImportErrorCode } from "../videos/source-import-policy";
import { mcpNumber, scopeNames } from "./mcp-config";

export type McpCategory = "READ" | "EDITOR_WRITE" | "GENERATION" | "EXPORT";
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
const stable = (v: unknown): string =>
  JSON.stringify(
    v && typeof v === "object"
      ? Array.isArray(v)
        ? v.map((item) => JSON.parse(stable(item)))
        : Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, item]) => [k, JSON.parse(stable(item))]),
          )
      : v,
  );
const messages: Record<string, string> = {
  ...reviewMessages,
  AUTH_REQUIRED: "Connect your XeeClip account.",
  AUTH_EXPIRED: "Reconnect XeeClip to continue.",
  TOKEN_REVOKED: "This connection was revoked. Reconnect XeeClip.",
  INSUFFICIENT_SCOPE: "Reconnect XeeClip and allow the requested permission.",
  INSUFFICIENT_CREDITS: "No generations remaining.",
  XEEPRO_BUSY: "XeePro is busy right now. Try XeeFree or try again later.",
  EDIT_CONFLICT:
    "This video changed. Read its latest revision before editing again.",
  NOT_FOUND: "This XeeClip resource was not found.",
  FORBIDDEN: "This operation is not allowed.",
  INVALID_INPUT: "Check the tool inputs and try again.",
  EDIT_VALIDATION_FAILED:
    "This edit is not supported for the selected video or element.",
  EXPORT_FAILED:
    "The video could not be exported. Review it in XeeClip and retry.",
  GENERATION_FAILED:
    "Clips could not be started. Check the source in XeeClip and retry.",
  JOB_FAILED: "Processing could not finish. Review the job in XeeClip.",
  HOOK_DOES_NOT_FIT: 'This hook does not fit. Shorten it or adjust its text box.',
  TEXT_DOES_NOT_FIT: 'This text does not fit. Shorten it, reduce its size or resize its box.',
  PLACEMENT_CONFLICT: 'The selected region has no safe free space. Choose another region or adjust its layers.',
  PLACEMENT_TARGET_REQUIRED: 'Choose the existing element whose geometry should be reused.',
  EDIT_CONSTRAINT_BLOCKED: 'An editor protection blocks this change. Review the protected edit before retrying.',
  HEADLINE_DOES_NOT_FIT:
    "This headline does not fit. Shorten it and try again.",
  AI_CONSENT_REQUIRED:
    "Allow AI processing in XeeClip Settings before using XeePro.",
  UNSUPPORTED_SOURCE:
    "This URL or source is not supported. Check supported sources and operation limits.",
  SOURCE_UNAVAILABLE:
    "This video is unavailable or has been removed. Check the link.",
  SOURCE_PRIVATE: "This video is private and cannot be imported.",
  SOURCE_LOGIN_REQUIRED:
    "This video requires sign-in or restricted access and cannot be imported.",
  SOURCE_DRM_PROTECTED: "This video is protected and cannot be imported.",
  SOURCE_TOO_LONG:
    "Source videos can be up to 3 hours long. Choose a shorter video.",
  SOURCE_REGION_RESTRICTED: "This video is not available in this region.",
  SOURCE_IMPORT_FAILED:
    "The source could not be imported. Check the public video link and try again later.",
  UNSUPPORTED_OPERATION:
    "This operation is not currently supported by the canonical XeeClip editor.",
  IDEMPOTENCY_CONFLICT:
    "This idempotency key belongs to different inputs. Use a new key for a new action.",
  OPERATION_INTERRUPTED:
    "The previous request was interrupted. Read the current XeeClip state before starting a new action.",
  RATE_LIMITED: "Too many XeeClip requests. Wait before trying again.",
};
export function safeMcpError(error: any, category: McpCategory = "READ") {
  const body =
    typeof error?.getResponse === "function" ? error.getResponse() : undefined;
  let code =
    error instanceof McpToolError || error instanceof VideoReviewError
      ? error.code
      : error instanceof ImportError
        ? sourceImportErrorCode(error.code)
        : typeof body === "object"
          ? body?.code
          : undefined;
  if (code === "NO_CREDITS") code = "INSUFFICIENT_CREDITS";
  if (code === "STALE_REVISION") code = "EDIT_CONFLICT";
  const status =
    typeof error?.getStatus === "function" ? error.getStatus() : 500;
  code =
    code && messages[code]
      ? code
      : status === 404
        ? "NOT_FOUND"
        : status === 403
          ? "FORBIDDEN"
          : status === 409
            ? "EDIT_CONFLICT"
            : status === 400
              ? "EDIT_VALIDATION_FAILED"
              : category === "EXPORT"
                ? "EXPORT_FAILED"
                : category === "GENERATION"
                  ? "GENERATION_FAILED"
                  : "JOB_FAILED";
  const details = error instanceof McpToolError ? error.details : undefined;
  const requiredScopes = Array.isArray(details?.requiredScopes)
    ? details.requiredScopes.filter(
        (s) => typeof s === "string" && scopeNames.includes(s as any),
      )
    : undefined;
  return {
    code,
    message: messages[code],
    ...(typeof details?.recommendedPollAfterMs === "number"
      ? { recommendedPollAfterMs: details.recommendedPollAfterMs }
      : {}),
    ...(requiredScopes?.length ? { requiredScopes } : {}),
  };
}
@Injectable()
export class McpOperationsService implements OnModuleDestroy {
  private readonly redis = new Redis(
    process.env.REDIS_URL || "redis://localhost:6379",
    { maxRetriesPerRequest: 1 },
  );
  private readonly logger = new Logger("MCP");
  private cleanupAt = 0;
  constructor(private readonly prisma: PrismaService) {}
  async onModuleDestroy() {
    await this.redis.quit();
  }
  identity(auth: AuthInfo) {
    const userId = auth.extra?.userId,
      connectionId = auth.extra?.connectionId;
    if (typeof userId !== "string" || typeof connectionId !== "string")
      throw new McpToolError("AUTH_REQUIRED", messages.AUTH_REQUIRED);
    return { userId, connectionId, clientId: auth.clientId };
  }
  async rate(auth: AuthInfo, category: McpCategory) {
    const { userId, clientId } = this.identity(auth);
    const limits = {
      READ: mcpNumber("MCP_RATE_LIMIT_READ", 180, 10, 600),
      EDITOR_WRITE: mcpNumber("MCP_RATE_LIMIT_WRITE", 40, 1, 120),
      GENERATION: mcpNumber("MCP_RATE_LIMIT_GENERATION", 6, 1, 20),
      EXPORT: mcpNumber("MCP_RATE_LIMIT_EXPORT", 10, 1, 30),
    };
    // Both user and client buckets apply: another connection cannot bypass a user's budget.
    for (const key of ["u:" + userId, "c:" + userId + ":" + clientId]) {
      const n = Number(
        await this.redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          1,
          "mcp:rate:" + category + ":" + key,
        ),
      );
      if (n > limits[category])
        throw new McpToolError("RATE_LIMITED", messages.RATE_LIMITED, {
          recommendedPollAfterMs: 60000,
        });
    }
  }
  async health() {
    await Promise.all([this.redis.ping(), this.prisma.mcpClient.count()]);
  }
  async readStream<T>(auth: AuthInfo, run: () => Promise<T>) {
    const identity = this.identity(auth);
    const tool = { name: "xeeclip_download_export", category: "READ" as const };
    if (!auth.scopes.includes("xeeclip:clips:export"))
      throw new McpToolError("INSUFFICIENT_SCOPE", messages.INSUFFICIENT_SCOPE);
    await this.rate(auth, "READ");
    try {
      const stream = await requestIdentity.run(
        { userId: identity.userId, admin: false, adminView: false },
        run,
      );
      await this.audit(identity, tool, undefined, "SUCCESS");
      return stream;
    } catch (error) {
      const safe = safeMcpError(error);
      await this.audit(identity, tool, undefined, safe.code);
      throw new McpToolError(safe.code, safe.message);
    }
  }
  async invoke(
    auth: AuthInfo,
    tool: { name: string; scopes: string[]; category: McpCategory },
    input: Record<string, unknown>,
    run: () => Promise<unknown>,
  ) {
    const identity = this.identity(auth);
    let actionId: string | undefined;
    let ownsAction = false;
    try {
      if (tool.scopes.some((s) => !auth.scopes.includes(s)))
        throw new McpToolError(
          "INSUFFICIENT_SCOPE",
          messages.INSUFFICIENT_SCOPE,
        );
      await this.rate(auth, tool.category);
      // This is a field projection, not a consent initializer. OFF must also
      // block cached idempotent receipts, without widening any OAuth scope.
      if (tool.scopes.includes("xeeclip:media:review")) {
        const reviewAccount = await this.prisma.user.findUnique({
          where: { id: identity.userId },
          select: { aiVideoReviewEnabled: true, status: true },
        });
        if (!reviewAccount || reviewAccount.status !== "ACTIVE")
          throw new McpToolError("AUTH_REQUIRED", messages.AUTH_REQUIRED);
        if (!reviewAccount.aiVideoReviewEnabled)
          throw new VideoReviewError("AI_VIDEO_REVIEW_DISABLED");
      }
      if (tool.category !== "READ") {
        const key = input.idempotencyKey;
        if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,100}$/.test(key))
          throw new McpToolError("INVALID_INPUT", messages.INVALID_INPUT);
        const inputHash = createHash("sha256")
          .update(stable(input))
          .digest("hex");
        let action;
        try {
          action = await this.prisma.mcpAction.create({
            data: {
              userId: identity.userId,
              clientId: identity.clientId,
              tool: tool.name,
              key,
              inputHash,
            },
          });
        } catch (e: any) {
          if (e.code !== "P2002") throw e;
          action = await this.prisma.mcpAction.findUniqueOrThrow({
            where: {
              userId_clientId_tool_key: {
                userId: identity.userId,
                clientId: identity.clientId,
                tool: tool.name,
                key,
              },
            },
          });
          actionId = action.id;
          if (action.inputHash !== inputHash)
            throw new McpToolError(
              "IDEMPOTENCY_CONFLICT",
              messages.IDEMPOTENCY_CONFLICT,
            );
          if (action.status === "COMPLETE") {
            await this.audit(
              identity,
              tool,
              actionId,
              "SUCCESS",
              action.entityId,
            );
            return action.result;
          }
          if (action.status === "FAILED") {
            // These consent guards run before generation, reservations or edits.
            // A saved consent change must unblock the SAME assistant request.
            const consentRetry =
              action.failureCode === "AI_CONSENT_REQUIRED" &&
              input.mode === "XEEPRO" &&
              [
                "xeeclip_create_clips",
                "xeeclip_quick_reframe",
                "xeeclip_understand_campaign",
                "xeeclip_generate_campaign_clips",
              ].includes(tool.name) &&
              !!(
                await this.prisma.user.findUnique({
                  where: { id: identity.userId },
                  select: { aiProcessingConsentAt: true },
                })
              )?.aiProcessingConsentAt;
            const reviewRetry =
              action.failureCode === "AI_VIDEO_REVIEW_DISABLED" &&
              tool.name === "xeeclip_request_video_review" &&
              !!(
                await this.prisma.user.findUnique({
                  where: { id: identity.userId },
                  select: { aiVideoReviewEnabled: true },
                })
              )?.aiVideoReviewEnabled;
            const evidenceRetry =
              action.failureCode === "AI_VIDEO_REVIEW_EVIDENCE_REQUIRED" &&
              tool.name === "xeeclip_complete_video_review" &&
              typeof input.reviewPassId === "string" &&
              typeof input.reviewRequestId === "string" &&
              !!(await this.prisma.aiVideoReviewPass.findFirst({
                where: {
                  id: input.reviewPassId,
                  accessedAt: { not: null },
                  evidenceType: "ACTUAL_RENDERED_MEDIA",
                  grant: {
                    userId: identity.userId,
                    clientId: identity.clientId,
                    reviewRequestId: input.reviewRequestId,
                    scope: "REVIEW_MEDIA_ONLY",
                    status: "APPROVED",
                    revokedAt: null,
                    consumedAt: null,
                    expiresAt: { gt: new Date() },
                    request: { connectionId: identity.connectionId },
                  },
                },
                select: { id: true },
              }));
            if (!consentRetry && !reviewRetry && !evidenceRetry)
              throw new McpToolError(
                action.failureCode || "JOB_FAILED",
                messages[action.failureCode || "JOB_FAILED"],
              );
            // Only one concurrent retry may reclaim the failed precondition.
            const claimed = await this.prisma.mcpAction.updateMany({
              where: {
                id: action.id,
                inputHash,
                status: "FAILED",
                failureCode: action.failureCode,
              },
              data: {
                status: "PENDING",
                failureCode: null,
                completedAt: null,
                createdAt: new Date(),
              },
            });
            ownsAction = claimed.count === 1;
          }
          if (!ownsAction) {
            if (
              action.status !== "FAILED" &&
              Date.now() - action.createdAt.getTime() > 120000
            )
              throw new McpToolError(
                "OPERATION_INTERRUPTED",
                messages.OPERATION_INTERRUPTED,
              );
            return {
              actionId,
              status: "QUEUED",
              requestInProgress: true,
              recommendedPollAfterMs: 5000,
            };
          }
        }
        actionId = action.id;
        ownsAction = true;
      }
      const result = await requestIdentity.run(
        {
          userId: identity.userId,
          admin: false,
          adminView: false,
          operationId: actionId,
        },
        run,
      );
      const safe = JSON.parse(
        JSON.stringify(result ?? {}, (_key, value) =>
          typeof value === "bigint" ? Number(value) : value,
        ),
      );
      if (actionId) {
        const prior = await this.prisma.mcpAction.findUniqueOrThrow({
          where: { id: actionId },
        });
        if (prior.status === "COMPLETE") {
          await this.audit(identity, tool, actionId, "SUCCESS", prior.entityId);
          return prior.result;
        }
        await this.prisma.mcpAction.updateMany({
          where: { id: actionId, status: "PENDING" },
          data: { status: "COMPLETE", result: safe, completedAt: new Date() },
        });
      }
      const entityId = [
        input.editProjectId,
        input.campaignId,
        input.clipId,
        input.sourceId,
        input.importId,
        input.reframeId,
        input.campaignClipId,
      ].find((v) => typeof v === "string");
      await this.audit(
        identity,
        tool,
        actionId,
        "SUCCESS",
        entityId as string | undefined,
      );
      return safe;
    } catch (error) {
      // A committed canonical receipt wins even if dispatch lost its HTTP response afterwards.
      if (
        actionId &&
        !(
          error instanceof McpToolError && error.code === "IDEMPOTENCY_CONFLICT"
        )
      ) {
        const action = await this.prisma.mcpAction.findUnique({
          where: { id: actionId },
        });
        if (action?.status === "COMPLETE") return action.result;
      }
      const safe = safeMcpError(error, tool.category);
      if (actionId && ownsAction && safe.code !== "IDEMPOTENCY_CONFLICT")
        await this.prisma.mcpAction.updateMany({
          where: { id: actionId, status: "PENDING" },
          data: {
            status: "FAILED",
            failureCode: safe.code,
            completedAt: new Date(),
          },
        });
      await this.audit(identity, tool, actionId, safe.code);
      throw new McpToolError(safe.code, safe.message, {
        ...("recommendedPollAfterMs" in safe
          ? { recommendedPollAfterMs: safe.recommendedPollAfterMs }
          : {}),
        ...("requiredScopes" in safe
          ? { requiredScopes: safe.requiredScopes }
          : {}),
      });
    }
  }
  private async audit(
    identity: { userId: string; connectionId: string; clientId: string },
    tool: { name: string; category: McpCategory },
    actionId: string | undefined,
    result: string,
    entityId?: string | null,
  ) {
    await this.prisma.mcpAudit.create({
      data: {
        ...identity,
        tool: tool.name,
        actionId,
        entityId,
        result,
        creditEffect:
          tool.name === "xeeclip_import_source"
            ? "NO_CREDIT_CHARGE"
            : tool.category === "GENERATION"
              ? "CANONICAL_LEDGER"
              : tool.category === "EXPORT"
                ? "CANONICAL_EXPORT_POLICY"
                : "NONE",
      },
    });
    this.logger.log(
      JSON.stringify({
        event:
          result === "RATE_LIMITED"
            ? "mcp_rate_limits"
            : result === "XEEPRO_BUSY"
              ? "mcp_xeepro_busy"
              : "mcp_tool_calls",
        tool: tool.name,
        category: tool.category,
        result,
        actionId: actionId || null,
      }),
    );
    if (result !== "SUCCESS")
      this.logger.warn(
        JSON.stringify({
          event: "mcp_tool_errors",
          tool: tool.name,
          code: result,
        }),
      );
    else if (tool.category !== "READ")
      this.logger.log(
        JSON.stringify({
          event:
            tool.category === "GENERATION"
              ? "mcp_create_jobs"
              : tool.category === "EXPORT"
                ? "mcp_exports"
                : "mcp_editor_mutations",
          tool: tool.name,
          actionId,
        }),
      );
    // Audit retention is bounded. Idempotency receipts are retained so an old key never replays a charge.
    if (Date.now() - this.cleanupAt > 600000) {
      this.cleanupAt = Date.now();
      const rows = await this.prisma.mcpAudit.findMany({
        where: { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } },
        take: 1000,
        select: { id: true },
      });
      if (rows.length)
        await this.prisma.mcpAudit.deleteMany({
          where: { id: { in: rows.map((r) => r.id) } },
        });
      const cutoff = new Date(Date.now() - 86400000);
      const [auth, tokens] = await Promise.all([
        this.prisma.mcpAuthorization.findMany({
          where: { expiresAt: { lt: cutoff } },
          take: 1000,
          select: { requestHash: true },
        }),
        this.prisma.mcpToken.findMany({
          where: { expiresAt: { lt: cutoff } },
          take: 1000,
          select: { hash: true },
        }),
      ]);
      if (auth.length)
        await this.prisma.mcpAuthorization.deleteMany({
          where: { requestHash: { in: auth.map((r) => r.requestHash) } },
        });
      if (tokens.length)
        await this.prisma.mcpToken.deleteMany({
          where: { hash: { in: tokens.map((r) => r.hash) } },
        });
    }
  }
}
