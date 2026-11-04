"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eye } from "lucide-react";
import { apiFetch, getPublicApiBaseUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/bottom-sheet";

type Finding = {
  type: string;
  severity: string;
  start: number;
  end: number;
  message: string;
};
type Review = {
  reviewRequestId: string;
  clipId: string;
  clientName: string;
  purpose: string;
  status: string;
  expiresAt: string;
  editorUrl: string | null;
  passes: Array<{
    id: string;
    status: string;
    verdict: string | null;
    evidenceType: string;
    findings: Finding[];
  }>;
};
type Settings = {
  enabled: boolean;
  connections: Array<{ id: string; name: string }>;
  requests: Review[];
};
type Consent = {
  reviewRequestId: string;
  clientName: string;
  purpose: string;
  status: string;
  nonce: string | null;
};
const labels: Record<string, string> = {
  PENDING_USER_APPROVAL: "Waiting for approval",
  APPROVED: "Approved · waiting for review",
  REVIEWING: "Reviewing",
  COMPLETE: "Review complete",
  EXPIRED: "Access expired",
  REVOKED: "Access revoked",
  DENIED: "Review declined",
  FAILED: "Review failed",
};
const clock = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
const getSettings = () => apiFetch<Settings>("/mcp/reviews");

function Approval({
  id,
  onClose,
  onChange,
}: {
  id: string;
  onClose: () => void;
  onChange: (approved?: boolean) => void;
}) {
  const [data, setData] = useState<Consent | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revisions, setRevisions] = useState(false);
  useEffect(() => {
    void apiFetch<Consent>(`/mcp/reviews/${id}/consent`)
      .then(setData)
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "Could not load this request.",
        ),
      );
  }, [id]);
  async function decide(approve: boolean) {
    if (!data?.nonce) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/mcp/reviews/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonce: data.nonce,
          approve,
          allowRevisions: approve && revisions,
        }),
      });
      onChange(approve);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your choice.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <BottomSheet
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Allow AI to review this video?"
      role="dialog"
      desktopWidth="md:max-w-xl"
    >
      {data ? (
        <div className="grid min-w-0 gap-4">
          <p className="break-words text-sm">
            <strong>{data.clientName}</strong> wants temporary read-only access
            to this rendered video and its audio.
          </p>
          <video
            src={`${getPublicApiBaseUrl()}/mcp/reviews/${id}/preview`}
            controls
            playsInline
            preload="metadata"
            className="max-h-64 w-full rounded-xl bg-black"
            aria-label="Video requested for review"
          />
          <p className="break-words text-sm">
            <strong>Reason: </strong>
            {data.purpose}
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            It may view this video's pixels, listen to its audio, and inspect
            frames and timecodes for editing problems. Access lasts up to 15
            minutes and ends when the review is complete.
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            This permission gives no access to other videos, source library,
            campaigns, account details, credits, billing, editor data or private
            storage. Editing and export require separate permissions.
          </p>
          <p className="rounded-xl border border-border p-3 text-sm leading-6">
            An assistant can understand anything visible or audible in the video
            you approve. Review cannot hide that content from it.
          </p>
          {data.nonce ? (
            <>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={revisions}
                  onChange={(e) => setRevisions(e.target.checked)}
                  disabled={busy}
                  className="mt-1"
                />
                <span>
                  Also allow reviews of revisions of this same clip during this
                  edit session, up to 3 render versions within 15 minutes.
                </span>
              </label>
              <div className="flex flex-wrap justify-end gap-3">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void decide(false)}
                >
                  Cancel
                </Button>
                <Button disabled={busy} onClick={() => void decide(true)}>
                  {busy
                    ? "Saving…"
                    : revisions
                      ? "Allow this edit session"
                      : "Allow Once"}
                </Button>
              </div>
            </>
          ) : (
            <p role="status">
              {labels[data.status] ||
                "This request is no longer awaiting approval."}
            </p>
          )}
        </div>
      ) : (
        !error && <p role="status">Loading review request…</p>
      )}
      {error && (
        <p role="alert" className="mt-3 break-words text-sm text-danger-soft">
          {error}
        </p>
      )}
    </BottomSheet>
  );
}

export function AiVideoReviews() {
  const [data, setData] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [approval, setApproval] = useState<string | null>(null),
    [dismissed, setDismissed] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    try {
      setData(await getSettings());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reviews are unavailable.");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("review");
    if (id && /^[\da-f-]{36}$/i.test(id)) setApproval(id);
  }, []);
  async function toggle() {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch("/mcp/reviews/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !data.enabled }),
      });
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save review settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await apiFetch(`/mcp/reviews/${id}/revoke`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not revoke this review.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="grid min-w-0 gap-4 border-t border-border pt-4"
      aria-label="AI Video Review"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="ai-video-review-label" className="font-semibold">
          AI Video Review
        </h3>
        <button
          type="button"
          role="switch"
          aria-labelledby="ai-video-review-label"
          aria-checked={data?.enabled ?? false}
          disabled={!data || busy}
          onClick={() => void toggle()}
          className="btn-primary min-h-11 rounded-xl px-4 text-sm"
        >
          {busy ? "Saving…" : data?.enabled ? "On · Turn off" : "Off · Turn on"}
        </button>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        Allow connected AI assistants to request temporary access to review a
        video's visual and audio quality. You will approve each review before
        access is granted.
      </p>
      {data && (
        <p role="status" className="text-xs text-muted-foreground">
          {data.enabled
            ? "On. Each video still needs your approval."
            : "Off. Video review access is disabled."}
        </p>
      )}
      {data?.requests
        .filter((r) => !dismissed.includes(r.reviewRequestId))
        .map((r) => (
          <article
            key={r.reviewRequestId}
            className="grid min-w-0 gap-3 rounded-xl border border-border p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <h4 className="break-words font-semibold">{r.clientName}</h4>
              <span className="text-sm text-muted-foreground">
                {labels[r.status] || r.status}
              </span>
            </div>
            <p className="break-words text-xs text-muted-foreground">
              Video {r.clipId.slice(0, 8)} · {r.purpose}
            </p>
            {["APPROVED", "REVIEWING", "PENDING_USER_APPROVAL"].includes(
              r.status,
            ) && (
              <p className="text-xs text-muted-foreground">
                Expires {new Date(r.expiresAt).toLocaleTimeString()}
              </p>
            )}
            {r.passes.map((pass) => (
              <div key={pass.id} className="grid gap-2">
                <p className="text-sm">
                  {pass.verdict === "NEEDS_CHANGES"
                    ? "Needs changes"
                    : pass.verdict === "REVIEWED"
                      ? "Reviewed"
                      : "Review evidence"}{" "}
                  ·{" "}
                  {pass.evidenceType === "ACTUAL_RENDERED_MEDIA"
                    ? "Actual rendered media; sampled coverage"
                    : "Metadata only; media has not been inspected"}
                </p>
                {pass.findings.map((f, i) => (
                  <p key={i} className="break-words text-sm">
                    <strong>
                      {clock(f.start)} · {f.severity}
                    </strong>{" "}
                    {f.message}
                  </p>
                ))}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {r.status === "PENDING_USER_APPROVAL" && (
                <Button
                  disabled={busy || !data.enabled}
                  onClick={() => setApproval(r.reviewRequestId)}
                >
                  Review request
                </Button>
              )}
              {[
                "APPROVED",
                "REVIEWING",
                "PENDING_USER_APPROVAL",
                "FAILED",
              ].includes(r.status) && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void revoke(r.reviewRequestId)}
                >
                  Revoke
                </Button>
              )}
              {r.editorUrl && (
                <>
                  <Button variant="secondary" asChild>
                    <Link href={`${r.editorUrl}?panel=ai`} prefetch={false}>
                      Fix with AI
                    </Link>
                  </Button>
                  <Button variant="secondary" asChild>
                    <Link href={r.editorUrl} prefetch={false}>
                      Open Editor
                    </Link>
                  </Button>
                </>
              )}
              {["COMPLETE", "DENIED", "EXPIRED", "REVOKED", "FAILED"].includes(
                r.status,
              ) && (
                <Button
                  variant="ghost"
                  onClick={() => setDismissed((v) => [...v, r.reviewRequestId])}
                >
                  Dismiss
                </Button>
              )}
            </div>
          </article>
        ))}
      {error && (
        <p role="alert" className="break-words text-sm text-danger-soft">
          {error}
        </p>
      )}
      {approval && (
        <Approval
          id={approval}
          onClose={() => setApproval(null)}
          onChange={() => void refresh()}
        />
      )}
    </div>
  );
}

export function CheckWithAi({
  clipId,
  disabled = false,
}: {
  clipId: string;
  disabled?: boolean;
}) {
  const [approvedReview, setApprovedReview] = useState(false);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Settings | null>(null),
    [connection, setConnection] = useState(""),
    [approval, setApproval] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function show() {
    setOpen(true);
    setError("");
    try {
      const d = await getSettings();
      setData(d);
      setConnection(d.connections[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review is unavailable.");
    }
  }
  async function enable() {
    setBusy(true);
    try {
      await apiFetch("/mcp/reviews/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      setData(await getSettings());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not enable video review.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function request() {
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<{ reviewRequestId: string }>(
        "/mcp/reviews/requests",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, connectionId: connection }),
        },
      );
      setApproval(r.reviewRequestId);
      setOpen(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not request this review.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => void show()}
      >
        <Eye size={15} />
        Check with AI
      </Button>
      {open && (
        <BottomSheet
          open
          title="Check with AI"
          role="dialog"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          desktopWidth="md:max-w-lg"
        >
          <div className="grid min-w-0 gap-4">
            <p className="text-sm leading-6">
              Choose a connected assistant to review this rendered video. You
              will see the exact video and approve its temporary read-only
              access before anything is shared. Editing requires separate
              permission.
            </p>
            {data && !data.enabled && (
              <>
                <p className="text-sm">AI Video Review is off.</p>
                <Button disabled={busy} onClick={() => void enable()}>
                  Turn on AI Video Review
                </Button>
              </>
            )}
            {data && !data.connections.length && (
              <p className="text-sm">
                Reconnect your assistant with the new video review permission,
                then return here.{" "}
                <Link href="/settings" className="underline">
                  Open Settings
                </Link>
              </p>
            )}
            {!!data?.connections.length && (
              <label className="grid gap-2 text-sm">
                Assistant
                <select
                  value={connection}
                  onChange={(e) => setConnection(e.target.value)}
                  className="min-h-11 min-w-0 rounded-xl border border-border bg-inset p-2"
                >
                  {data.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !data?.enabled || !connection}
                onClick={() => void request()}
              >
                Continue to approval
              </Button>
            </div>
            {error && (
              <p role="alert" className="break-words text-sm text-danger-soft">
                {error}
              </p>
            )}
          </div>
        </BottomSheet>
      )}
      {approval && (
        <Approval
          id={approval}
          onClose={() => setApproval(null)}
          onChange={(approved) => setApprovedReview(approved === true)}
        />
      )}
      {approvedReview && (
        <p role="status" className="text-sm text-muted-foreground">
          Approved. Return to your connected assistant and ask it to check this
          video. It can find this approval without access to your library.
        </p>
      )}
    </>
  );
}
