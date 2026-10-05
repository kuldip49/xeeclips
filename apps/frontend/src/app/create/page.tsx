import { AppShell } from '@/components/app-shell';
import { CreateClipsFlow } from '@/components/create-clips-flow';

export const metadata = { title: 'Create clips' };

/**
 * The one-step Create flow: source, template, count, Generate. No project has to be named first;
 * one is created from the video and the user lands in it as soon as the upload/import starts.
 */
export default function CreatePage() {
  return <AppShell title='Create clips' backHref='/dashboard' backLabel='Back to home'>
    <div className='mx-auto grid w-full max-w-2xl gap-5'>
      <header>
        <h1 className='text-[26px] font-bold leading-tight tracking-tight md:text-3xl'>Create clips</h1>
        <p className='mt-1.5 text-sm leading-6 text-slate-400'>Turn a long video into short clips with hooks, captions and hashtags.</p>
      </header>
      <CreateClipsFlow />
    </div>
  </AppShell>;
}
