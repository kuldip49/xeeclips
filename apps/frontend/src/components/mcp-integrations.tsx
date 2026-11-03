"use client";
import { useEffect, useState } from "react";
import { Link2, Copy, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
type Connection = {
  id: string;
  name: string;
  connectedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  permissions: Array<{ id: string; label: string }>;
};
type Integrations = { mcpUrl: string; connections: Connection[] };
export function McpIntegrations() {
  const [data, setData] = useState<Integrations | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const refresh = () =>
    apiFetch<Integrations>("/mcp/connections")
      .then(setData)
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "Connections are unavailable.",
        ),
      );
  useEffect(() => {
    void refresh();
  }, []);
  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      await apiFetch("/mcp/connections/" + id + "/revoke", { method: "POST" });
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not revoke this connection.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      aria-labelledby="mcp-integrations-title"
      className="mt-6 grid min-w-0 gap-5 rounded-2xl border border-border bg-surface p-5"
    >
      <div className="flex items-center gap-3">
        <Link2 className="text-primary-soft" size={22} />
        <div>
          <p className="eyebrow">Integrations</p>
          <h2
            id="mcp-integrations-title"
            className="font-display text-xl font-semibold"
          >
            AI Assistants
          </h2>
        </div>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        Connect a compatible AI assistant to create clips, work with campaigns,
        edit and export in XeeClip. You choose its permissions when connecting.
      </p>
      {data && (
        <>
          <div className="grid min-w-0 gap-2 rounded-xl border border-border bg-sunken p-3">
            <span className="text-xs font-semibold text-muted-foreground">
              Remote MCP address
            </span>
            <code className="break-all text-sm">{data.mcpUrl}</code>
            <Button
              variant="secondary"
              className="justify-self-start"
              onClick={() =>
                void navigator.clipboard
                  .writeText(data.mcpUrl)
                  .then(() => setCopied(true))
                  .catch(() => setError("Select and copy the address above."))
              }
            >
              <Copy size={15} />
              {copied ? "Copied" : "Copy address"}
            </Button>
          </div>
          <div className="grid gap-3">
            <h3 className="font-semibold">Connected apps</h3>
            {!data.connections.some((c) => !c.revokedAt) && (
              <p className="text-sm text-muted-foreground">
                No active connections.
              </p>
            )}
            {data.connections
              .filter((c) => !c.revokedAt)
              .map((c) => (
                <article
                  key={c.id}
                  className="grid min-w-0 gap-3 rounded-xl border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h4 className="min-w-0 flex-1 break-words font-semibold [overflow-wrap:anywhere]">
                      {c.name}
                    </h4>
                    <Button
                      variant="secondary"
                      disabled={busy === c.id}
                      onClick={() => void revoke(c.id)}
                    >
                      {busy === c.id ? "Revoking..." : "Revoke"}
                    </Button>
                  </div>
                  <ul className="grid gap-1 text-sm text-muted-foreground">
                    {c.permissions.map((p) => (
                      <li key={p.id}>{p.label}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-faint">
                    Connected {new Date(c.connectedAt).toLocaleDateString()}
                    {c.lastUsedAt
                      ? " / Last used " +
                        new Date(c.lastUsedAt).toLocaleDateString()
                      : ""}
                  </p>
                </article>
              ))}
          </div>
        </>
      )}
      {!data && !error && (
        <p role="status" className="text-sm">
          Loading connections...
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-danger-soft">
          {error}
        </p>
      )}
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" />
        Revoking an app immediately ends its access. Your XeeClip login stays
        active.
      </p>
    </section>
  );
}
