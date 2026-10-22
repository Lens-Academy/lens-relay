// A result paragraph that opens, on click, as a live editor of its range in the source file:
// edits and comments made here are edits and comments in that file. One paragraph is live at
// a time across the tab (lib/embed-docs.ts); Escape or a click outside closes it, and so does
// focus leaving it for nowhere, which is what Escape does under Vimium (it takes the key).
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { embedViewExtensions } from '../Editor/extensions/noteEmbed';
import { ySectionSync, ySectionSyncFacet, ySectionUndoManagerKeymap } from '../SectionEditor/y-section-sync';
import { closeLive, isLive, openLive } from '../../lib/embed-docs';
import { attachProvenanceRegistration, humanActor } from '../../lib/provenance';
import { insertCommentInYText } from '../../lib/ytext-comment-ops';
import { paragraphRange } from '../../lib/source-range';
import { useAuth } from '../../contexts/AuthContext';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../App';
import type { Para } from './types';

type State = 'idle' | 'connecting' | 'live' | 'lost' | 'error';
const CUT = 280;

const theme = EditorView.theme({
  '&.cm-editor .cm-content': { padding: '0', maxWidth: 'none', margin: '0' },
  '&.cm-editor .cm-scroller': { overflow: 'visible', fontFamily: 'inherit', lineHeight: '1.6' },
  '&.cm-editor': { fontSize: 'inherit', background: 'transparent' },
  '&.cm-editor.cm-focused': { outline: 'none' },
});

export function SourceParagraph({ para }: { para: Para }) {
  const { metadata } = useNavigation();
  const { canEdit } = useAuth();
  const { displayName } = useDisplayName();
  const nameRef = useRef(displayName);
  useEffect(() => { nameRef.current = displayName; }, [displayName]);
  const [state, setState] = useState<State>('idle');
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [owner] = useState(() => ({}));
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<{ view: EditorView; detach: () => void; stop: () => void } | null>(null);
  const unmounted = useRef(false);
  const docId = metadata?.['/' + para.path]?.id;

  const ended = useCallback(() => {
    const cur = live.current;
    live.current = null;
    if (cur) {
      cur.stop();
      cur.detach();
      cur.view.destroy();
    }
    if (!unmounted.current) setState((s) => (s === 'lost' || s === 'error' ? s : 'idle'));
  }, []);

  const start = useCallback(async () => {
    if (!docId || !canEdit || live.current || isLive(owner)) return;
    setState('connecting');
    let opened;
    try {
      opened = await openLive(`${RELAY_ID}-${docId}`, owner, ended);
    } catch {
      if (isLive(owner)) closeLive(owner);
      setState('error');
      return;
    }
    if (!opened) return;
    if (unmounted.current || !host.current) { closeLive(owner); return; }
    const { doc } = opened.connection;
    const ytext = doc.getText('contents');
    const range = paragraphRange(ytext.toString(), para.line, para.text);
    if (!range) { setState('lost'); closeLive(owner); return; }
    const detach = attachProvenanceRegistration(doc, () => humanActor(nameRef.current ?? ''));
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext.toString().slice(range.from, range.to),
        extensions: [
          ...embedViewExtensions(canEdit),
          theme,
          keymap.of([{ key: 'Escape', run: () => { closeLive(owner); return true; } }]),
          ySectionUndoManagerKeymap,
          keymap.of(defaultKeymap),
          ySectionSync(ytext, range.from, range.to, { endExclusive: true }),
          EditorView.contentAttributes.of({ 'aria-label': `Source of ${para.path}:${para.line}` }),
        ],
      }),
    });
    // A click in here may move focus to no element; it is not a close while the button is down.
    let pressed = false;
    const onDown = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node)) pressed = true; else closeLive(owner);
    };
    const onUp = () => setTimeout(() => { pressed = false; }, 0);
    // Focus gone to no element, while this window keeps it and no click is in progress.
    const onFocusOut = () => setTimeout(() => {
      if (pressed || !document.hasFocus()) return;
      const to = document.activeElement;
      if (!to || to === document.body) closeLive(owner);
    }, 0);
    const el = box.current!;
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mouseup', onUp, true);
    el.addEventListener('focusout', onFocusOut);
    const stop = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mouseup', onUp, true);
      el.removeEventListener('focusout', onFocusOut);
    };
    live.current = { view, detach, stop };
    setState('live');
    requestAnimationFrame(() => view.focus());
  }, [docId, canEdit, owner, ended, para]);

  useEffect(() => {
    unmounted.current = false;
    return () => { unmounted.current = true; closeLive(owner); };
  }, [owner]);

  /** Insert a comment at the cursor, into the source file's text. */
  const addComment = () => {
    const cur = live.current;
    if (!cur || !comment.trim()) return;
    const conf = cur.view.state.facet(ySectionSyncFacet);
    insertCommentInYText(conf.ytext, comment.trim(), conf.sectionFrom + cur.view.state.selection.main.head);
    setComment('');
    cur.view.focus();
  };

  const long = para.text.length > CUT;
  const editing = state === 'live' || state === 'connecting';
  return (
    <div ref={box} className={`rounded ${editing ? 'bg-white px-2 py-1 ring-1 ring-sky-200' : ''}`}>
      {!editing && (
        <div className={`whitespace-pre-wrap text-[13px] leading-relaxed text-gray-800 ${docId && canEdit ? 'cursor-text hover:bg-sky-50' : ''}`}
          title={docId && canEdit ? 'Click to edit this paragraph in its source file' : undefined}
          onClick={() => (docId && canEdit ? void start() : long && setOpen(!open))}>
          {long && !open ? para.text.slice(0, CUT) + '…' : para.text}
        </div>
      )}
      <div ref={host} className={editing ? 'text-[13px] text-gray-900' : 'hidden'} data-testid="source-paragraph-editor" />
      {state === 'connecting' && <div className="text-[11px] text-gray-400">opening the source file…</div>}
      {state === 'live' && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
          <span className="whitespace-nowrap">editing the source file live · Esc closes</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="comment at the cursor…"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addComment(); } }}
            className="min-w-0 flex-1 rounded border border-gray-200 px-1.5 py-0.5" />
          <button onClick={addComment} disabled={!comment.trim()} className="rounded border border-gray-300 px-2 py-0.5 disabled:opacity-40">Comment</button>
        </div>
      )}
      {state === 'lost' && <div className="text-[11px] text-amber-700">This paragraph is no longer where the corpus saw it; open the file to find it.</div>}
      {state === 'error' && <div className="text-[11px] text-red-700">Could not open the source file.</div>}
    </div>
  );
}
