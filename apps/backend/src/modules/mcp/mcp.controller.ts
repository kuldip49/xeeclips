import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { requestIdentity } from "../auth/request-context";
import { McpOAuthService } from "./mcp-oauth.service";
import { McpOperationsService } from "./mcp-operations.service";
import { MCP_VERSION } from "./mcp-config";
@Controller("mcp")
export class McpController {
  constructor(
    private readonly oauth: McpOAuthService,
    private readonly ops: McpOperationsService,
  ) {}
  @Get("health") async health() {
    try {
      await this.ops.health();
      return {
        status: "ok",
        version: MCP_VERSION,
        transport: "streamable-http",
        dependencies: { database: "ok", redis: "ok" },
      };
    } catch {
      throw new ServiceUnavailableException(
        "XeeClip MCP is temporarily unavailable.",
      );
    }
  }
  @Get("oauth/consent/:request") consent(@Param("request") request: string) {
    return this.oauth.consent(request, requestIdentity.getStore()!.userId!);
  }
  @Post("oauth/consent/:request") decide(
    @Param("request") request: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.oauth.decide(
      request,
      requestIdentity.getStore()!.userId!,
      body,
    );
  }
  @Get("connections") connections() {
    return this.oauth.connections(requestIdentity.getStore()!.userId!);
  }
  @Post("connections/:id/revoke") revoke(@Param("id") id: string) {
    return this.oauth.revokeConnection(id, requestIdentity.getStore()!.userId!);
  }
}
