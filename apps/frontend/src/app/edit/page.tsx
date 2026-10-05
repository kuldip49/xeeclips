import { AppShell } from '@/components/app-shell';
import { HistoryView } from '@/components/history-view';

export const metadata = { title: 'Edit clips' };

export default function EditPage() {
  return <AppShell><HistoryView mode='edit' /></AppShell>;
}
