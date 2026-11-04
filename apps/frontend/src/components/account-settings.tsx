"use client";
import { useState } from "react";
import Link from "next/link";
import { useAuth } from "./auth-provider";

export function AccountSettings() {
  const { user, preferences, logout } = useAuth();
  const [name, setName] = useState(user?.displayName ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const aiEnabled = !!user?.aiProcessingConsentAt;

  async function save(value: { displayName?: string; aiProcessingConsent?: boolean }) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await preferences(value);
      setMessage(typeof value.aiProcessingConsent === "boolean"
        ? `AI processing is ${value.aiProcessingConsent ? "on" : "off"}.`
        : "Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 grid min-w-0 gap-5 rounded-2xl border border-border bg-surface p-5">
      <h2 className="font-display text-lg font-semibold">Your account</h2>
      <p className="break-words text-soft">{user?.email}</p>
      <label className="grid gap-2 text-sm">Name
        <input value={name} onChange={e => setName(e.target.value)} maxLength={100} className="min-w-0 rounded-xl border border-border bg-inset p-3" />
      </label>
      <button disabled={busy} onClick={() => void save({ displayName: name })} className="btn-primary min-h-11 rounded-xl px-4">Save name</button>
      <p>{user?.role === "ADMIN" ? "Unlimited generations" : `${user?.creditBalance ?? 0} credits remaining`}</p>
      <div className="grid gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="ai-processing-label" className="font-semibold">Allow AI processing</h3>
          <button type="button" role="switch" aria-checked={aiEnabled} aria-labelledby="ai-processing-label" aria-describedby="ai-processing-help" disabled={busy}
            onClick={() => void save({ aiProcessingConsent: !aiEnabled })}
            className="btn-primary min-h-11 rounded-xl px-4 text-sm">
            {busy ? "Saving…" : aiEnabled ? "On · Turn off" : "Off · Turn on"}
          </button>
        </div>
        <p id="ai-processing-help" className="text-sm leading-6 text-muted-foreground">Allow XeePro and Ask AI to process your prompts and relevant video content. This applies to your connected assistant too. Turn it off here at any time. XeeFree works with this off.</p>
      </div>
      {message && <p role="status" className="text-sm text-soft">{message}</p>}
      {error && <p role="alert" className="text-sm text-danger-soft">{error}</p>}
      {user?.role === "ADMIN" && <Link href="/admin" className="text-primary-soft">Open Admin</Link>}
      <button onClick={() => void logout()} className="min-h-11 rounded-xl border border-border px-4">Log out</button>
    </section>
  );
}
