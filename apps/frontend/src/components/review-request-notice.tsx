"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
export function ReviewRequestNotice() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void apiFetch<{ count: number }>("/mcp/reviews/pending-count")
        .then((r) => {
          if (live) setCount(r.count);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 30000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  return count ? (
    <div
      role="status"
      className="mb-4 rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm"
    >
      <Link href="/settings">
        {count === 1
          ? "An assistant is requesting video review access."
          : `${count} video review requests are waiting.`}{" "}
        Review in Settings
      </Link>
    </div>
  ) : null;
}
