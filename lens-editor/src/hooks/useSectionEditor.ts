import { useEffect, useRef } from 'react';
import type { EditorView } from 'codemirror';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { createSectionEditorView } from '../components/SectionEditor/createSectionEditorView';

interface UseSectionEditorOpts {
  ytext: Y.Text | null;
  sectionFrom: number;
  sectionTo: number;
  active: boolean;
  /** Stable identity for the current edit target. When this changes, the editor
   *  is recreated with the new range. Without this, switching directly between
   *  two fields (both active=true) won't remount the editor. */
  editKey?: string | null;
  awareness?: Awareness;
  /** Opt in to the criticmarkup extension stack. Default false so existing
   *  callers keep their current behavior. */
  enableCriticMarkup?: boolean;
  /** Initial suggestion mode for criticmarkup-enabled editors. Ignored when
   *  enableCriticMarkup is false. */
  initialSuggestionMode?: boolean;
  /** Fires when the user clicks an inline comment badge (`cm-comment-badge`)
   *  in the editor. The argument is the absolute Y.Text position of the
   *  thread, translated from the section editor's local position. */
  onCommentBadgeClick?: (absoluteFrom: number) => void;
  /** Fires when the user invokes the "Add Comment" keyboard shortcut inside
   *  the section editor (Mod-Shift-m). */
  onRequestAddComment?: () => void;
}

/**
 * Manages CodeMirror editor lifecycle for editing a section of a Y.Text.
 *
 * When `active` becomes true, creates a CM editor bound to [sectionFrom, sectionTo)
 * of the Y.Text via ySectionSync. When `active` becomes false, destroys it.
 *
 * The effect depends ONLY on `active` — range values are read from a ref at effect time.
 * This prevents cursor-jump bugs where reactive range state changes on every Y.Text edit.
 */
export function useSectionEditor(opts: UseSectionEditorOpts) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    if (!opts.active || !mountRef.current || !optsRef.current.ytext) return;

    const {
      ytext,
      sectionFrom,
      sectionTo,
      awareness,
      enableCriticMarkup,
      initialSuggestionMode,
    } = optsRef.current;

    // Read the latest callback at click time so we don't capture a stale
    // reference if the parent re-binds it.
    const onCommentBadgeClick = (absoluteFrom: number) => {
      optsRef.current.onCommentBadgeClick?.(absoluteFrom);
    };
    const onRequestAddComment = () => {
      optsRef.current.onRequestAddComment?.();
    };

    const view = createSectionEditorView({
      ytext: ytext!,
      sectionFrom,
      sectionTo,
      awareness,
      parent: mountRef.current,
      enableCriticMarkup,
      initialSuggestionMode,
      onCommentBadgeClick,
      onRequestAddComment,
    });

    viewRef.current = view;
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.active, opts.editKey, opts.enableCriticMarkup, opts.initialSuggestionMode]);

  return { mountRef, viewRef };
}
