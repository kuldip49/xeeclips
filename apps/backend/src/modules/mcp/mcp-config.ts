export const MCP_VERSION = "1.2.0";
export const MCP_SCOPES = {
  "xeeclip:account:read": "View your account",
  "xeeclip:credits:read": "View your credits",
  "xeeclip:sources:read": "View your source videos",
  "xeeclip:sources:import":
    "Import authorized external video links into your source library",
  "xeeclip:clips:read": "View your clips and jobs",
  "xeeclip:clips:create": "Create clips using your credits",
  "xeeclip:clips:edit": "Edit your clips in XeeClip",
  "xeeclip:clips:export": "Export your clips",
  "xeeclip:reframe:create": "Use Quick Reframe",
  "xeeclip:campaigns:read": "View campaigns, assets and compliance",
  "xeeclip:campaigns:create": "Create campaigns and understand rules",
  "xeeclip:campaigns:generate": "Generate campaign clips using your credits",
  "xeeclip:history:read": "View your History",
  "xeeclip:media:review":
    "Request human-approved access to one rendered video and audio",
  offline_access: "Keep this assistant connected until you revoke access",
} as const;
export type McpScope = keyof typeof MCP_SCOPES;
export const scopeNames = Object.keys(MCP_SCOPES) as McpScope[];
export function mcpNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error("Invalid MCP configuration: " + name);
  return n;
}
export function mcpConfig() {
  const resource = new URL(
    process.env.MCP_PUBLIC_URL || "https://api.xeeclip.me/mcp",
  );
  const issuer = new URL(process.env.MCP_ISSUER_URL || resource.origin);
  const frontend = new URL(
    (process.env.FRONTEND_ORIGIN || "http://localhost:3000").split(",")[0],
  );
  for (const url of [resource, issuer, frontend]) {
    const local =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      (!local && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid MCP public URL configuration");
  }
  if (
    resource.pathname !== "/mcp" ||
    issuer.origin !== resource.origin ||
    issuer.pathname !== "/"
  )
    throw new Error(
      "MCP issuer must be the API origin and resource must end in /mcp",
    );
  return {
    resource,
    issuer,
    frontend,
    accessTtl: mcpNumber("MCP_ACCESS_TOKEN_TTL", 900, 60, 3600),
    refreshTtl: mcpNumber("MCP_REFRESH_TOKEN_TTL", 2592000, 3600, 7776000),
  };
}
