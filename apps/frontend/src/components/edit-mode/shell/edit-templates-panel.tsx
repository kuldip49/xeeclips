'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight, Check, Copy, Loader2, Pencil, Save, Sparkles, Trash2, TriangleAlert, X
} from 'lucide-react';
import {
  applyTemplate, aspectHint, captionHint, colorHint, deleteTemplate, duplicateTemplate,
  getTemplateLibrary, motionHint, previewTemplate, renameTemplate, saveTemplateFromProject,
  templateSwatch, type EditTemplate, type TemplateApplyResult, type TemplateLibrary,
  type TemplateProposal
} from '@/lib/edit-mode-templates';

/**
 * The template browser.
 *
 * Choosing a template never changes anything: it asks the server for a bounded
 * diff and shows it as "Will change" / "Will preserve". Only Apply writes, and
 * that is one undoable revision. Cancel goes back to the grid having touched
 * nothing at all.
 */

const Hint = ({ children }: { children: React.ReactNode }) =>
  <span className='truncate rounded bg-white/[.06] px-1.5 py-0.5 text-[9px] text-slate-400'>
    {children}</span>;

/** One card. The swatch is two colours derived from the template's own filter -
 *  no stock imagery, nothing fetched. */
function TemplateCard({ template, busy, onChoose, onRename, onDuplicate, onDelete }: {
  template: EditTemplate; busy: boolean; onChoose: () => void;
  onRename?: () => void; onDuplicate: () => void; onDelete?: () => void;
}) {
  const [from, to] = templateSwatch(template);
  return <div data-testid='template-card' data-template-id={template.id}
    className='group min-w-0 rounded-xl border border-white/[.08] bg-white/[.03] p-2 transition hover:border-white/20'>
    <button type='button' disabled={busy} onClick={onChoose}
      aria-label={`Preview ${template.name}`}
      className='grid w-full min-w-0 gap-1.5 text-left disabled:opacity-40'>
      <span aria-hidden className='block h-7 w-full rounded-md'
        style={{ background: `linear-gradient(110deg, ${from}, ${to})` }} />
      <span className='block truncate text-[12px] font-semibold text-slate-100'>{template.name}</span>
      <span className='line-clamp-2 block text-[10px] leading-snug text-slate-500'>
        {template.description}</span>
      <span className='flex flex-wrap gap-1 pt-0.5'>
        <Hint>{aspectHint(template)}</Hint>
        <Hint>{captionHint(template)}</Hint>
        <Hint>{colorHint(template)}</Hint>
        <Hint>{motionHint(template)}</Hint>
      </span>
    </button>
    <div className='mt-1.5 flex items-center gap-1 border-t border-white/[.06] pt-1.5'>
      <button type='button' disabled={busy} onClick={onChoose}
        className='flex-1 rounded-md bg-violet-500/15 py-1 text-[10px] font-semibold text-violet-200 hover:bg-violet-500/25 disabled:opacity-40'>
        Preview</button>
      <button type='button' disabled={busy} onClick={onDuplicate}
        aria-label={`Duplicate ${template.name}`} title='Duplicate'
        className='rounded-md p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30'>
        <Copy size={11} /></button>
      {onRename && <button type='button' disabled={busy} onClick={onRename}
        aria-label={`Rename ${template.name}`} title='Rename'
        className='rounded-md p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30'>
        <Pencil size={11} /></button>}
      {onDelete && <button type='button' disabled={busy} onClick={onDelete}
        aria-label={`Delete ${template.name}`} title='Delete'
        className='rounded-md p-1 text-slate-500 hover:bg-red-400/10 hover:text-red-300 disabled:opacity-30'>
        <Trash2 size={11} /></button>}
    </div>
  </div>;
}

export function EditTemplatesPanel({ projectId, revision, busy, hasSource, hasLogo, hasMusic,
  onApplied, onError }: {
  projectId: string; revision: number; busy: boolean; hasSource: boolean;
  hasLogo: boolean; hasMusic: boolean;
  onApplied: (result: TemplateApplyResult) => void;
  onError: (message: string) => void;
}) {
  const [library, setLibrary] = useState<TemplateLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  // The proposal currently on screen. Purely local: holding one has not written
  // anything, and dismissing it writes nothing either.
  const [proposal, setProposal] = useState<TemplateProposal | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [includeLogo, setIncludeLogo] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setLibrary(await getTemplateLibrary()); }
    catch (caught) { onError(caught instanceof Error ? caught.message : 'Could not load templates'); }
    finally { setLoading(false); }
  }, [onError]);
  useEffect(() => { void refresh(); }, [refresh]);

  const guard = async (task: () => Promise<void>) => {
    setWorking(true);
    try { await task(); }
    catch (caught) { onError(caught instanceof Error ? caught.message : 'Template action failed'); }
    finally { setWorking(false); }
  };

  const choose = (template: EditTemplate) => void guard(async () => {
    setProposal(await previewTemplate(projectId, revision, template.id));
  });
  const confirm = () => proposal && void guard(async () => {
    const result = await applyTemplate(projectId, revision, proposal.templateId);
    setProposal(null);
    onApplied(result);
  });
  const save = () => void guard(async () => {
    await saveTemplateFromProject({ editProjectId: projectId, name: saveName.trim(),
      includeLogo, includeMusic });
    setSaveOpen(false); setSaveName(''); setIncludeLogo(false); setIncludeMusic(false);
    await refresh();
  });
  const rename = (template: EditTemplate) => {
    const next = window.prompt('Rename this template', template.name);
    if (!next || next === template.name) return;
    void guard(async () => { await renameTemplate(template.id, { name: next }); await refresh(); });
  };
  const duplicate = (template: EditTemplate) => void guard(async () => {
    await duplicateTemplate(template.id); await refresh();
  });
  const remove = (template: EditTemplate) => void guard(async () => {
    await deleteTemplate(template.id); await refresh();
  });

  const locked = busy || working;

  if (!hasSource) {
    return <p className='text-[11px] leading-relaxed text-slate-500'>
      Add a source video first. A template sets the style of an edit, so it needs an edit to
      style.</p>;
  }

  // --- The proposal view: what will change, what will be kept ----------------
  if (proposal) {
    return <div data-testid='template-proposal' className='grid min-w-0 gap-3'>
      <div className='grid gap-1'>
        <p className='text-[13px] font-semibold text-slate-100'>{proposal.templateName}</p>
        <p className='text-[10px] text-slate-500'>{proposal.summary}</p>
      </div>

      {proposal.warnings.map((warning) => <p key={warning}
        className='flex items-start gap-1.5 rounded-lg border border-amber-300/25 bg-amber-300/5 p-2 text-[10px] leading-snug text-amber-200'>
        <TriangleAlert size={11} className='mt-0.5 shrink-0' />{warning}</p>)}

      <div className='grid gap-1.5'>
        <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>
          Will change</p>
        {proposal.changes.length === 0
          ? <p className='text-[10px] text-slate-600'>Nothing — this clip already looks like
            this template.</p>
          : <ul data-testid='template-changes' className='grid gap-1'>
            {proposal.changes.map((change) => <li key={`${change.facet}-${change.label}`}
              className='flex min-w-0 items-center gap-1.5 rounded-md bg-white/[.04] px-2 py-1 text-[10px]'>
              <span className='min-w-0 flex-1 truncate text-slate-300'>{change.label}</span>
              <span className='shrink-0 text-slate-600 line-through'>{change.from}</span>
              <ArrowRight size={9} className='shrink-0 text-slate-600' />
              <span className='shrink-0 font-semibold text-cyan-200'>{change.to}</span>
            </li>)}
          </ul>}
      </div>

      <div className='grid gap-1.5'>
        <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>
          Will preserve</p>
        <ul data-testid='template-preserved' className='grid gap-1'>
          {proposal.preserved.map((item) => <li key={item.label}
            className='flex min-w-0 items-start gap-1.5 text-[10px] leading-snug'>
            <Check size={10} className='mt-0.5 shrink-0 text-emerald-400' />
            <span className='min-w-0'><span className='text-slate-300'>{item.label}</span>
              <span className='text-slate-600'> — {item.reason}</span></span>
          </li>)}
        </ul>
      </div>

      <div className='flex items-center gap-2'>
        <button type='button' data-testid='template-apply' disabled={locked} onClick={confirm}
          className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-500/20 py-2 text-[11px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:opacity-40'>
          {working ? <Loader2 size={12} className='animate-spin' /> : <Sparkles size={12} />}
          Apply</button>
        <button type='button' data-testid='template-cancel' disabled={working}
          onClick={() => setProposal(null)}
          className='flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-40'>
          <X size={11} />Cancel</button>
      </div>
      <p className='text-[9px] leading-snug text-slate-600'>
        Applying is one step in history, so Undo puts everything back. Every control stays
        editable afterwards — a template is a starting point, not a mode.</p>
    </div>;
  }

  // --- The grid --------------------------------------------------------------
  return <div className='grid min-w-0 gap-4'>
    {loading && <p className='flex items-center gap-1.5 text-[11px] text-slate-500'>
      <Loader2 size={12} className='animate-spin' />Loading templates…</p>}

    {library && <>
      <div className='grid min-w-0 gap-2'>
        <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>
          Built-in</p>
        <div className='grid min-w-0 gap-2'>
          {library.builtin.map((template) => <TemplateCard key={template.id} template={template}
            busy={locked} onChoose={() => choose(template)}
            onDuplicate={() => duplicate(template)} />)}
        </div>
      </div>

      <div className='grid min-w-0 gap-2'>
        <div className='flex items-center justify-between gap-2'>
          <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-500'>
            Saved by you</p>
          <span className='text-[9px] tabular-nums text-slate-600'>
            {library.user.length}/{library.limits.maxUserTemplates}</span>
        </div>

        {saveOpen ? <div data-testid='template-save-form'
          className='grid gap-2 rounded-xl border border-white/10 bg-white/[.03] p-2'>
          <input autoFocus value={saveName} maxLength={library.limits.maxNameLength}
            onChange={(event) => setSaveName(event.target.value)}
            placeholder='My Finance Reel' aria-label='Template name'
            className='w-full rounded-lg border border-white/10 bg-[#0b0f1a] px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-violet-400/50' />
          <label className='flex items-center gap-1.5 text-[10px] text-slate-400'>
            <input type='checkbox' checked={includeLogo} disabled={!hasLogo}
              onChange={(event) => setIncludeLogo(event.target.checked)} />
            Include current logo{!hasLogo && ' (none in this clip)'}</label>
          <label className='flex items-center gap-1.5 text-[10px] text-slate-400'>
            <input type='checkbox' checked={includeMusic} disabled={!hasMusic}
              onChange={(event) => setIncludeMusic(event.target.checked)} />
            Include current music{!hasMusic && ' (none in this clip)'}</label>
          <p className='text-[9px] leading-snug text-slate-600'>
            Without these, the template is portable: it saves your styling, not your files, your
            caption wording or your cuts.</p>
          <div className='flex gap-2'>
            <button type='button' disabled={locked || !saveName.trim()} onClick={save}
              className='flex-1 rounded-lg bg-violet-500/20 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:opacity-40'>
              Save</button>
            <button type='button' onClick={() => setSaveOpen(false)}
              className='rounded-lg border border-white/10 px-3 py-1.5 text-[10px] text-slate-300 hover:bg-white/5'>
              Cancel</button>
          </div>
        </div> : <button type='button' data-testid='template-save-open' disabled={locked}
          onClick={() => setSaveOpen(true)}
          className='flex items-center justify-center gap-1.5 rounded-lg border border-white/10 py-2 text-[11px] font-medium text-slate-200 hover:bg-white/5 disabled:opacity-30'>
          <Save size={12} />Save this style as a template</button>}

        {library.user.length === 0
          ? <p className='text-[10px] leading-snug text-slate-600'>
            Nothing saved yet. Style a clip the way you like it, then save it here and apply it
            to any other clip.</p>
          : <div className='grid min-w-0 gap-2'>
            {library.user.map((template) => <TemplateCard key={template.id} template={template}
              busy={locked} onChoose={() => choose(template)}
              onRename={() => rename(template)} onDuplicate={() => duplicate(template)}
              onDelete={() => remove(template)} />)}
          </div>}
        <p className='text-[9px] leading-snug text-slate-600'>{library.scopeNote}</p>
      </div>
    </>}
  </div>;
}
