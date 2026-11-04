"use client";
import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Connection = { id: string; name: string; revokedAt: string | null };
type Integrations = { connections: Connection[] };

export function McpIntegrations() {
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = async () => {
    try {
      setData(await apiFetch<Integrations>("/mcp/connections"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connections are unavailable.");
    }
  };
  useEffect(() => { void refresh(); }, []);

  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      await apiFetch("/mcp/connections/" + id + "/revoke", { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect this assistant.");
    } finally {
      setBusy(null);
    }
  }

  const active = data?.connections.filter(c => !c.revokedAt) ?? [];
  return (
    <section aria-labelledby="mcp-integrations-title" className="mt-6 grid min-w-0 gap-4 rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-3">
        <Link2 className="text-primary-soft" size={22} />
        <h2 id="mcp-integrations-title" className="font-display text-xl font-semibold">AI Assistants</h2>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">Your connected assistant can import videos, create clips, edit and export in your XeeClip account. XeePro uses the AI processing setting above.</p>
      {data && !active.length && <p className="text-sm text-muted-foreground">No assistant connected.</p>}
      {active.map(c => (
        <article key={c.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
          <div className="min-w-0 flex-1">
            <h3 className="break-words font-semibold [overflow-wrap:anywhere]">{c.name}</h3>
            <p className="text-sm text-muted-foreground">Connected</p>
          </div>
          <Button variant="secondary" disabled={busy === c.id} onClick={() => void revoke(c.id)}>{busy === c.id ? "Disconnecting…" : "Disconnect"}</Button>
        </article>
      ))}
      {!data && !error && <p role="status" className="text-sm">Loading connections…</p>}
      {error && <p role="alert" className="break-words text-sm text-danger-soft">{error}</p>}
    </section>
  );
}
