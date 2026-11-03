"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, Link2, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
type Consent = {
  clientName: string;
  verifiedPublisher: boolean;
  nonce: string;
  permissions: Array<{ id: string; label: string }>;
  expiresAt: string;
};
export function McpConsent() {
  const request = useSearchParams().get("request") || "";
  const [data, setData] = useState<Consent | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    apiFetch<Consent>("/mcp/oauth/consent/" + encodeURIComponent(request))
      .then((v) => {
        if (active) {
          setData(v);
          setSelected(v.permissions.map((p) => p.id));
        }
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "This connection request could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [request]);
  async function decide(allow: boolean) {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const value = await apiFetch<{ redirectUrl: string }>(
        "/mcp/oauth/consent/" + encodeURIComponent(request),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nonce: data.nonce,
            allow,
            scopes: allow ? selected : [],
          }),
        },
      );
      window.location.assign(value.redirectUrl);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not finish connecting. Start again from your assistant.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto grid w-full max-w-xl min-w-0 gap-6 rounded-3xl border border-border bg-surface p-5 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary-soft">
          <Link2 size={24} />
        </span>
        <div>
          <p className="eyebrow">XeeClip connection</p>
          <h1 className="mt-1 font-display text-2xl font-bold">
            Connect an AI assistant
          </h1>
        </div>
      </div>
      {data ? (
        <>
          <p className="min-w-0 break-words text-lg [overflow-wrap:anywhere]">
            <strong>{data.clientName}</strong> wants access to your XeeClip
            account.
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            Only allow this if you started connecting from an assistant you
            trust. The app name is supplied by its developer.
          </p>
          <fieldset className="grid gap-3" disabled={busy}>
            <legend className="mb-3 font-semibold">
              Choose what it can do
            </legend>
            {data.permissions.map((p) => (
              <label
                key={p.id}
                className="flex min-h-11 items-start gap-3 rounded-xl border border-border p-3 text-sm"
              >
                <input
                  className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected((values) =>
                      e.target.checked
                        ? [...values, p.id]
                        : values.filter((x) => x !== p.id),
                    )
                  }
                />
                <span>{p.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="flex items-start gap-2 rounded-xl bg-sunken p-3 text-sm leading-6 text-muted-foreground">
            <ShieldCheck className="mt-1 shrink-0" size={18} />
            Your usual credits and ownership rules apply. You can revoke this
            connection anytime in Settings.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !selected.length}
              onClick={() => void decide(true)}
            >
              {busy ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Connecting...
                </>
              ) : (
                "Allow"
              )}
            </Button>
          </div>
        </>
      ) : !error ? (
        <p role="status">Loading requested permissions...</p>
      ) : null}
      {error && (
        <p
          role="alert"
          className="break-words rounded-xl border border-danger/20 bg-danger/10 p-3 text-sm text-danger-soft"
        >
          {error}
        </p>
      )}
      <Link href="/settings" className="text-sm text-primary-soft underline">
        Back to Settings
      </Link>
    </div>
  );
}
