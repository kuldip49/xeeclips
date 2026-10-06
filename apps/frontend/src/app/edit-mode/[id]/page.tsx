import { Suspense } from 'react';
import { EditModeProjectRoute } from '@/components/edit-mode/edit-mode-project-route';
import { EditModeLoadingScreen } from '@/components/edit-mode/edit-mode-route-states';

/**
 * The editor deliberately does not use AppShell.
 *
 * A professional editing layout needs the whole viewport: AppShell's 64px nav,
 * 72px header and max-w-[1440px] padded main would cost roughly a third of the
 * height at 1366x768, which is exactly the height the preview and timeline
 * need. The top bar carries its own "Projects" link back into the app.
 *
 * The static build prerenders one shell (`_`); the Cloudflare router serves it for every
 * `/edit-mode/<id>` and the page loads that project in the browser.
 */
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function EditModeProjectPage() {
  return <Suspense fallback={<EditModeLoadingScreen />}><EditModeProjectRoute /></Suspense>;
}
