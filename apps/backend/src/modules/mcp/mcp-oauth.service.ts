import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { PrismaService } from "../database/prisma.service";
import { MCP_SCOPES, mcpConfig, scopeNames } from "./mcp-config";

// Secrets exist only for the lifetime of the SDK's client-authentication middleware.
export const oauthClientSecret = new AsyncLocalStorage<string | undefined>();
export const mcpDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const equalHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const readScopes = scopeNames.filter(
  (s) => s.endsWith(":read") || s === "offline_access",
);
export function validateScopes(scopes: string[]) {
  if (
    !scopes.length ||
    scopes.length > scopeNames.length ||
    scopes.some((s) => !Object.hasOwn(MCP_SCOPES, s))
  )
    throw new InvalidScopeError("Choose supported XeeClip permissions.");
  return [...new Set(scopes)];
}
export function validateRedirect(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidClientMetadataError("Invalid redirect URI.");
  }
  const native =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    value.length > 2048 ||
    url.username ||
    url.password ||
    url.hash ||
    (!native &&
      (url.protocol !== "https:" ||
        isIP(url.hostname.replace(/[\[\]]/g, "")) ||
        !url.hostname.includes(".") ||
        /\.(local|internal|localhost|invalid)$/i.test(url.hostname)))
  )
    throw new InvalidClientMetadataError(
      "Use an HTTPS callback or a native loopback callback.",
    );
  return value;
}

@Injectable()
export class McpOAuthService implements OAuthServerProvider {
  private readonly logger = new Logger("MCP");
  readonly clientsStore: OAuthRegisteredClientsStore;
  constructor(private readonly prisma: PrismaService) {
    this.clientsStore = {
      getClient: (id) => this.getClient(id),
      registerClient: (client) => this.registerClient(client),
    };
  }
  private async getClient(
    id: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    if (typeof id !== "string" || id.length > 200) return undefined;
    const row = await this.prisma.mcpClient.findUnique({ where: { id } });
    if (!row) return undefined;
    const metadata = row.metadata as unknown as OAuthClientInformationFull;
    const supplied = oauthClientSecret.getStore();
    return {
      ...metadata,
      client_id: row.id,
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      ...(row.secretHash
        ? {
            client_secret:
              supplied && equalHash(mcpDigest(supplied), row.secretHash)
                ? supplied
                : random(),
          }
        : {}),
    };
  }
  private async registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): Promise<OAuthClientInformationFull> {
    if (!client.redirect_uris.length || client.redirect_uris.length > 10)
      throw new InvalidClientMetadataError("Provide one to ten callback URIs.");
    client.redirect_uris.forEach(validateRedirect);
    if (
      client.grant_types?.some(
        (g) => !["authorization_code", "refresh_token"].includes(g),
      ) ||
      client.response_types?.some((r) => r !== "code")
    )
      throw new InvalidClientMetadataError(
        "Only authorization code with PKCE is supported.",
      );
    const method = client.token_endpoint_auth_method || "client_secret_post";
    if (!["none", "client_secret_post"].includes(method))
      throw new InvalidClientMetadataError(
        "Unsupported client authentication.",
      );
    const name = String(client.client_name || "AI assistant")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 100);
    const scope = validateScopes(
      client.scope ? client.scope.split(/\s+/).filter(Boolean) : scopeNames,
    ).join(" ");
    const secret = method === "none" ? undefined : client.client_secret;
    if (method !== "none" && !secret)
      throw new InvalidClientMetadataError("A client credential is required.");
    const metadata = {
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name,
      scope,
      ...(secret
        ? { client_secret_expires_at: client.client_secret_expires_at || 0 }
        : {}),
    };
    const row = await this.prisma.mcpClient.create({
      data: {
        id: randomUUID(),
        name,
        metadata,
        secretHash: secret ? mcpDigest(secret) : null,
      },
    });
    return {
      ...metadata,
      client_id: row.id,
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      ...(secret ? { client_secret: secret } : {}),
    };
  }
  private checkResource(resource?: URL) {
    if (resource && resource.href !== mcpConfig().resource.href)
      throw new InvalidGrantError("Wrong XeeClip resource.");
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    this.checkResource(params.resource);
    const scopes = validateScopes(
      params.scopes?.length ? params.scopes : readScopes,
    );
    const available = new Set(
      (client.scope || scopeNames.join(" ")).split(" "),
    );
    if (scopes.some((s) => !available.has(s)))
      throw new InvalidScopeError(
        "Permission was not registered for this client.",
      );
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) ||
      (params.state?.length || 0) > 2048
    )
      throw new InvalidGrantError("Invalid authorization request.");
    validateRedirect(params.redirectUri);
    const request = random();
    await this.prisma.mcpAuthorization.create({
      data: {
        requestHash: mcpDigest(request),
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        resource: mcpConfig().resource.href,
        challenge: params.codeChallenge,
        scopes,
        state: params.state,
        expiresAt: new Date(Date.now() + 300000),
      },
    });
    const target = new URL("/mcp/authorize", mcpConfig().frontend);
    target.searchParams.set("request", request);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, target.href);
  }
  async consent(request: string, userId: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(request))
      throw new NotFoundException("Connection request not found.");
    const key = mcpDigest(request),
      nonce = createHmac("sha256", request).update(userId).digest("base64url");
    const claimed = await this.prisma.mcpAuthorization.updateMany({
      where: {
        requestHash: key,
        decidedAt: null,
        expiresAt: { gt: new Date() },
        OR: [{ userId: null }, { userId }],
      },
      data: { userId, consentHash: mcpDigest(nonce) },
    });
    if (!claimed.count)
      throw new BadRequestException(
        "This connection request expired. Start connecting again.",
      );
    const row = await this.prisma.mcpAuthorization.findUniqueOrThrow({
      where: { requestHash: key },
      include: { client: true },
    });
    return {
      clientName: row.client.name,
      verifiedPublisher: false,
      nonce,
      permissions: row.scopes.map((id) => ({
        id,
        label: MCP_SCOPES[id as keyof typeof MCP_SCOPES],
      })),
      expiresAt: row.expiresAt,
    };
  }
  async decide(request: string, userId: string, body: Record<string, unknown>) {
    if (
      typeof body.nonce !== "string" ||
      typeof body.allow !== "boolean" ||
      !Array.isArray(body.scopes) ||
      !body.scopes.every((s) => typeof s === "string")
    )
      throw new BadRequestException("Review the connection permissions again.");
    const row = await this.prisma.mcpAuthorization.findUnique({
      where: { requestHash: mcpDigest(request) },
    });
    if (
      !row ||
      row.userId !== userId ||
      row.decidedAt ||
      row.expiresAt <= new Date() ||
      !row.consentHash ||
      !equalHash(mcpDigest(body.nonce), row.consentHash)
    )
      throw new BadRequestException(
        "This connection request expired. Start connecting again.",
      );
    const scopes = body.allow ? validateScopes(body.scopes as string[]) : [];
    if (scopes.some((s) => !row.scopes.includes(s)))
      throw new BadRequestException("Permission was not requested.");
    const code = random();
    const result = await this.prisma.mcpAuthorization.updateMany({
      where: {
        requestHash: row.requestHash,
        userId,
        decidedAt: null,
        consentHash: row.consentHash,
      },
      data: {
        decidedAt: new Date(),
        consentHash: null,
        scopes,
        codeHash: body.allow ? mcpDigest(code) : null,
        expiresAt: new Date(Date.now() + 120000),
      },
    });
    if (!result.count)
      throw new BadRequestException(
        "This connection request was already answered.",
      );
    const target = new URL(row.redirectUri);
    target.searchParams.set(
      body.allow ? "code" : "error",
      body.allow ? code : "access_denied",
    );
    if (row.state) target.searchParams.set("state", row.state);
    target.searchParams.set("iss", mcpConfig().issuer.href);
    return { redirectUrl: target.href };
  }
  private async code(client: OAuthClientInformationFull, code: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code))
      throw new InvalidGrantError("Invalid authorization code.");
    const row = await this.prisma.mcpAuthorization.findUnique({
      where: { codeHash: mcpDigest(code) },
    });
    if (
      !row ||
      row.clientId !== client.client_id ||
      !row.userId ||
      !row.decidedAt ||
      row.consumedAt ||
      row.expiresAt <= new Date()
    )
      throw new InvalidGrantError(
        "Authorization code expired or already used.",
      );
    return row;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    return (await this.code(client, code)).challenge;
  }
  private async issue(
    tx: any,
    grantId: string,
    scopes: string[],
  ): Promise<OAuthTokens> {
    const c = mcpConfig(),
      access = "xmcp_at_" + random(),
      refresh = "xmcp_rt_" + random();
    await tx.mcpToken.createMany({
      data: [
        {
          hash: mcpDigest(access),
          grantId,
          kind: "ACCESS",
          scopes,
          resource: c.resource.href,
          expiresAt: new Date(Date.now() + c.accessTtl * 1000),
        },
        ...(scopes.includes("offline_access")
          ? [
              {
                hash: mcpDigest(refresh),
                grantId,
                kind: "REFRESH",
                scopes,
                resource: c.resource.href,
                expiresAt: new Date(Date.now() + c.refreshTtl * 1000),
              },
            ]
          : []),
      ],
    });
    return {
      access_token: access,
      ...(scopes.includes("offline_access") ? { refresh_token: refresh } : {}),
      token_type: "Bearer",
      expires_in: c.accessTtl,
      scope: scopes.join(" "),
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.checkResource(resource);
    const row = await this.code(client, code);
    if (redirectUri !== row.redirectUri)
      throw new InvalidGrantError(
        "The callback does not match the authorization.",
      );
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: row.userId! },
        select: { status: true },
      });
      if (user?.status !== "ACTIVE")
        throw new InvalidGrantError("Account unavailable.");
      const claim = await tx.mcpAuthorization.updateMany({
        where: {
          requestHash: row.requestHash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (claim.count !== 1)
        throw new InvalidGrantError("Authorization code already used.");
      const grant = await tx.mcpGrant.create({
        data: {
          userId: row.userId!,
          clientId: client.client_id,
          resource: row.resource,
          scopes: row.scopes,
        },
      });
      const tokens = await this.issue(tx, grant.id, row.scopes);
      this.logger.log(
        JSON.stringify({
          event: "mcp_connections",
          action: "CONNECTED",
          connectionId: grant.id,
        }),
      );
      return tokens;
    });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    if (!/^xmcp_rt_[A-Za-z0-9_-]{43}$/.test(token))
      throw new InvalidGrantError("Invalid refresh token.");
    const row = await this.prisma.mcpToken.findUnique({
      where: { hash: mcpDigest(token) },
      include: { grant: { include: { user: { select: { status: true } } } } },
    });
    if (
      !row ||
      row.kind !== "REFRESH" ||
      row.grant.clientId !== client.client_id ||
      row.resource !== mcpConfig().resource.href ||
      row.grant.revokedAt ||
      row.expiresAt <= new Date() ||
      row.grant.user.status !== "ACTIVE"
    )
      throw new InvalidGrantError("Refresh token expired or revoked.");
    if (row.consumedAt) {
      await this.prisma.mcpGrant.update({
        where: { id: row.grantId },
        data: { revokedAt: new Date() },
      });
      throw new InvalidGrantError(
        "Refresh token replay detected. Reconnect XeeClip.",
      );
    }
    const selected = validateScopes(scopes?.length ? scopes : row.scopes);
    if (selected.some((s) => !row.scopes.includes(s)))
      throw new InvalidScopeError("Refresh cannot add permissions.");
    const result = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.mcpToken.updateMany({
        where: { hash: row.hash, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (!claim.count) {
        await tx.mcpGrant.update({
          where: { id: row.grantId },
          data: { revokedAt: new Date() },
        });
        return null;
      }
      return this.issue(tx, row.grantId, selected);
    });
    if (!result)
      throw new InvalidGrantError(
        "Refresh token replay detected. Reconnect XeeClip.",
      );
    return result;
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!/^xmcp_at_[A-Za-z0-9_-]{43}$/.test(token))
      throw new InvalidTokenError("AUTH_REQUIRED");
    const row = await this.prisma.mcpToken.findUnique({
      where: { hash: mcpDigest(token) },
      include: {
        grant: { include: { user: { select: { id: true, status: true } } } },
      },
    });
    if (
      !row ||
      row.kind !== "ACCESS" ||
      row.resource !== mcpConfig().resource.href ||
      row.grant.resource !== mcpConfig().resource.href
    )
      throw new InvalidTokenError("AUTH_REQUIRED");
    if (row.grant.revokedAt || row.grant.user.status !== "ACTIVE")
      throw new InvalidTokenError("TOKEN_REVOKED");
    if (row.expiresAt <= new Date())
      throw new InvalidTokenError("AUTH_EXPIRED");
    if (row.scopes.some((s) => !row.grant.scopes.includes(s)))
      throw new InvalidTokenError("AUTH_REQUIRED");
    await this.prisma.mcpGrant.updateMany({
      where: {
        id: row.grantId,
        OR: [
          { lastUsedAt: null },
          { lastUsedAt: { lt: new Date(Date.now() - 300000) } },
        ],
      },
      data: { lastUsedAt: new Date() },
    });
    return {
      token,
      clientId: row.grant.clientId,
      scopes: row.scopes,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      resource: new URL(row.resource),
      extra: { userId: row.grant.userId, connectionId: row.grantId },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    const token = await this.prisma.mcpToken.findUnique({
      where: { hash: mcpDigest(request.token) },
      include: { grant: true },
    });
    if (token?.grant.clientId === client.client_id)
      await this.prisma.mcpGrant.updateMany({
        where: { id: token.grantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
  }
  async connections(userId: string) {
    const rows = await this.prisma.mcpGrant.findMany({
      where: { userId },
      include: { client: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      mcpUrl: mcpConfig().resource.href,
      connections: rows.map((r) => ({
        id: r.id,
        name: r.client.name,
        connectedAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        permissions: r.scopes.map((id) => ({
          id,
          label: MCP_SCOPES[id as keyof typeof MCP_SCOPES],
        })),
      })),
    };
  }
  async revokeConnection(id: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const result = await tx.mcpGrant.updateMany({
        where: { id, userId },
        data: { revokedAt: new Date() },
      });
      if (!result.count) throw new NotFoundException("Connection not found.");
      const reviews = await tx.aiVideoReviewRequest.findMany({
        where: {
          userId,
          connectionId: id,
          status: {
            in: ["PENDING_USER_APPROVAL", "APPROVED", "REVIEWING", "FAILED"],
          },
        },
      });
      await tx.aiVideoReviewRequest.updateMany({
        where: { id: { in: reviews.map((r) => r.id) } },
        data: { status: "REVOKED" },
      });
      await tx.aiVideoReviewGrant.updateMany({
        where: { userId, reviewRequestId: { in: reviews.map((r) => r.id) } },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      if (reviews.length)
        await tx.aiVideoReviewAudit.createMany({
          data: reviews.map((r) => ({
            userId,
            clientId: r.clientId,
            clipId: r.clipId,
            reviewRequestId: r.id,
            event: "REVOKED",
          })),
        });
    });
    this.logger.log(
      JSON.stringify({
        event: "mcp_connections",
        action: "REVOKED",
        connectionId: id,
      }),
    );
    return { revoked: true };
  }
}
