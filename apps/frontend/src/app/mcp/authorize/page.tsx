import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { McpConsent } from "@/components/mcp-consent";
export const metadata = {
  title: "Connect an AI assistant",
  referrer: "no-referrer",
};
export default function McpAuthorizePage() {
  return (
    <AppShell>
      <Suspense fallback={<p role="status">Loading connection request...</p>}>
        <McpConsent />
      </Suspense>
    </AppShell>
  );
}
