'use client';

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';

/**
 * The app's one confirmation for irreversible actions (deleting a clip). A bottom sheet on phones
 * and a centred dialog from tablets up, with the safe choice first and the destructive one last.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, busyLabel, busy = false,
  onConfirm, onCancel }: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <BottomSheet open={open} onClose={() => { if (!busy) onCancel(); }} title={title} role='alertdialog'
    desktopWidth='md:max-w-sm'>
    <p className='text-sm leading-6 text-muted-foreground'>{description}</p>
    <div className='mt-5 grid grid-cols-2 gap-2 md:flex md:justify-end'>
      <Button type='button' variant='secondary' className='h-11 md:h-10' disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button type='button' variant='destructive' className='h-11 md:h-10' disabled={busy} onClick={onConfirm}
        data-testid='confirm-dialog-confirm'>
        {busy ? <Loader2 size={15} className='animate-spin' aria-hidden /> : null}{busy ? busyLabel ?? confirmLabel : confirmLabel}
      </Button>
    </div>
  </BottomSheet>;
}
