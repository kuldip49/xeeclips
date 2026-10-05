import { AppShell } from '@/components/app-shell';
import { HistoryView } from '@/components/history-view';

export const metadata = { title: 'History' };

export default function HistoryPage() {
  return <AppShell><HistoryView /></AppShell>;
}
