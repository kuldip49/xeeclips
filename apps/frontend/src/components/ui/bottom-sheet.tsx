'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMediaQuery, MOBILE_QUERY } from '@/lib/use-media-query';
import { useVisualViewport } from '@/lib/use-visual-viewport';

export type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Visible title is hidden but still names the dialog for assistive tech. */
  hideTitle?: boolean;
  description?: ReactNode;
  children: ReactNode;
  /** Pinned under the scrolling content (e.g. a primary action); respects the home indicator. */
  footer?: ReactNode;
  /** `full` is a full-screen modal on phones (players, long forms); `auto` hugs its content. */
  size?: 'auto' | 'tall' | 'full';
  /** On tablets/desktop the same content opens as a centred dialog. */
  desktopWidth?: string;
  /** Dark presentation for media (the video player). */
  tone?: 'default' | 'media';
  className?: string;
  bodyClassName?: string;
};

/**
 * The app's one modal surface.
 *
 * Phones get a bottom sheet: a grab handle that swipes it closed, a 44px close button, internal
 * scrolling that never exceeds the visible viewport, and padding for the home indicator. When an
 * on-screen keyboard is open on iOS the sheet rides on top of it (visualViewport), so a focused
 * field and its button stay visible. From the `md` breakpoint up it is a centred dialog.
 */
export function BottomSheet({ open, onClose, title, hideTitle = false, description, children, footer,
  size = 'auto', desktopWidth = 'md:max-w-lg', tone = 'default', className, bodyClassName }: BottomSheetProps) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const drag = useDragControls();
  const phone = useMediaQuery(MOBILE_QUERY) !== false;
  const viewport = useVisualViewport(open && phone);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => setMounted(true), []);

  // Esc closes, the page behind stops scrolling, and focus returns where it came from.
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => panel.current?.focus({ preventScroll: true }), 30);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', keydown);
      document.body.style.overflow = previousOverflow;
      restoreFocus.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;

  const visible = viewport.height ? `${viewport.height}px` : '100dvh';
  const maxHeight = size === 'full' && phone ? visible
    : `calc(${visible} - var(--safe-top) - ${phone ? 12 : 48}px)`;
  const dragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 650) onClose();
  };

  return createPortal(<AnimatePresence>
    {open && <div className='fixed inset-0 z-[80] flex items-end justify-center md:items-center md:p-6'
      style={phone && viewport.keyboardInset ? { bottom: viewport.keyboardInset } : undefined}>
      <motion.div aria-hidden className={cn('absolute inset-0', tone === 'media' ? 'bg-black/90' : 'bg-black/65 backdrop-blur-[2px]')}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .18 }}
        onClick={onClose} />
      <motion.div ref={panel} role='dialog' aria-modal='true' aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined} tabIndex={-1}
        data-testid='bottom-sheet'
        className={cn('relative flex w-full min-w-0 flex-col overflow-hidden border-white/10 outline-none',
          tone === 'media' ? 'bg-[#05070d]' : 'bg-[#0f1422]',
          size === 'full' ? 'rounded-none md:rounded-2xl' : 'rounded-t-[22px] md:rounded-2xl',
          'border-t md:border', desktopWidth, className)}
        style={{ maxHeight, ...(size === 'full' && phone ? { height: visible } : {}),
          ...(size === 'tall' && phone ? { height: `min(88dvh, ${maxHeight})` } : {}) }}
        initial={phone ? { y: '100%' } : { opacity: 0, y: 16, scale: .98 }}
        animate={phone ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
        exit={phone ? { y: '100%' } : { opacity: 0, y: 16, scale: .98 }}
        transition={{ type: 'spring', damping: 34, stiffness: 380, mass: .8 }}
        drag={phone ? 'y' : false} dragListener={false} dragControls={drag}
        dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: .7 }} onDragEnd={dragEnd}>
        <div className={cn('shrink-0 touch-none select-none', size === 'full' && phone ? 'pt-safe' : '')}
          onPointerDown={(event) => { if (phone) drag.start(event); }}>
          {size !== 'full' && <div aria-hidden className='mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-white/20 md:hidden' />}
          <div className={cn('flex min-h-[52px] items-center gap-2 pl-4 pr-1.5', hideTitle && 'min-h-[48px]')}>
            <div className={cn('min-w-0 flex-1', hideTitle && 'sr-only')}>
              <h2 id={titleId} className='truncate text-base font-semibold tracking-tight'>{title}</h2>
              {description ? <p id={descriptionId} className='truncate text-xs text-slate-400'>{description}</p> : null}
            </div>
            <button type='button' onClick={onClose} aria-label='Close'
              onPointerDown={(event) => event.stopPropagation()}
              className='ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400'>
              <X size={20} aria-hidden /></button>
          </div>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4',
          !footer && 'pb-[max(1rem,var(--safe-bottom))]', bodyClassName)}>{children}</div>
        {footer ? <div className='shrink-0 border-t border-white/[.07] bg-inherit px-4 pt-3 pb-[max(.75rem,var(--safe-bottom))]'>
          {footer}</div> : null}
      </motion.div>
    </div>}
  </AnimatePresence>, document.body);
}
