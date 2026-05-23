/**
 * Shared CodeMirror editor creation for section editing.
 * Used by both SectionEditor (single-doc) and MultiDocSectionEditor (multi-doc).
 */

import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';
import { remoteCursorTheme } from '../Editor/remoteCursorTheme';
import {
  criticMarkupExtension,
  toggleSuggestionMode,
} from '../Editor/extensions/criticmarkup';
import type { CriticMarkupCommentBadgeInfo } from '../Editor/extensions/criticmarkup';
import { criticMarkupKeymap } from '../Editor/extensions/criticmarkup-commands';

/**
 * Trim trailing newlines from section range so CM doesn't show an empty
 * editable line that would allow typing at the start of the next section.
 */
export function trimSectionEnd(fullText: string, from: number, to: number): number {
  let editTo = to;
  while (editTo > from && fullText[editTo - 1] === '\n') {
    editTo--;
  }
  return editTo;
}

/**
 * Create a CodeMirror EditorView for editing a section of a Y.Text.
 *
 * `enableCriticMarkup` opts the editor into the criticmarkup extension stack
 * (suggestion mode + decorations + accept/reject keymap). Off by default so
 * existing callers (SectionEditor, MultiDocSectionEditor, ModuleTreeEditor,
 * ArticleEmbed) are unchanged.
 *
 * `initialSuggestionMode` controls the initial Edit/Suggest mode for editors
 * that opt in. Ignored when `enableCriticMarkup` is false.
 */
export function createSectionEditorView(opts: {
  ytext: Y.Text;
  sectionFrom: number;
  sectionTo: number;
  awareness?: Awareness;
  parent: HTMLElement;
  enableCriticMarkup?: boolean;
  initialSuggestionMode?: boolean;
  /** Local comment badge map for this section slice, keyed by local source
   *  positions. Used by course editor fields to preserve document-wide
   *  comment numbering while only a slice is mounted in CodeMirror. */
  commentBadgeMap?: Map<number, CriticMarkupCommentBadgeInfo>;
  /** Fired when the user clicks an inline `cm-comment-badge` widget rendered
   *  by the criticmarkup plugin. The argument is the absolute Y.Text position
   *  of the comment thread (translated from the section editor's local
   *  position). Caller is expected to focus the thread in their own UI
   *  (e.g. open a sidebar). */
  onCommentBadgeClick?: (absoluteFrom: number) => void;
  /** Fired when the user invokes the "Add Comment" keyboard shortcut
   *  (Mod-Shift-m) inside this section editor. Caller is expected to open
   *  whatever UI it uses to author the comment (the EduEditor sidebar, in
   *  our case). The current cursor position can be read from the view at
   *  callback time. Only registered when `enableCriticMarkup` is true. */
  onRequestAddComment?: () => void;
}): EditorView {
  const {
    ytext,
    sectionFrom,
    sectionTo,
    awareness,
    parent,
    enableCriticMarkup = false,
    initialSuggestionMode = false,
    commentBadgeMap,
    onCommentBadgeClick,
    onRequestAddComment,
  } = opts;

  // Add-comment keyboard shortcut. Mirrors the markdown editor's
  // `Mod-Shift-m` binding so the muscle memory carries over between editors.
  // Only registered when criticmarkup is enabled — pure section editors
  // (frontmatter fields, etc.) shouldn't take this binding.
  const addCommentKeymap =
    enableCriticMarkup && onRequestAddComment
      ? [
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Shift-m',
                run: () => {
                  onRequestAddComment();
                  return true;
                },
              },
            ])
          ),
        ]
      : [];

  const fullText = ytext.toString();
  const editTo = trimSectionEnd(fullText, sectionFrom, sectionTo);
  const sectionText = fullText.slice(sectionFrom, editTo);

  const criticMarkupExtensions = enableCriticMarkup
    ? [criticMarkupExtension({ canAcceptReject: true, commentBadgeMap }), keymap.of(criticMarkupKeymap)]
    : [];

  const view = new EditorView({
    state: EditorState.create({
      doc: sectionText,
      extensions: [
        indentUnit.of('\t'),
        EditorState.tabSize.of(4),
        drawSelection(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ySectionUndoManagerKeymap,
        keymap.of(defaultKeymap),
        markdown({ base: markdownLanguage, addKeymap: false }),
        ySectionSync(ytext, sectionFrom, editTo, { awareness }),
        remoteCursorTheme,
        EditorView.lineWrapping,
        ...criticMarkupExtensions,
        ...addCommentKeymap,
        EditorView.theme({
          '&': { fontSize: '14px', outline: 'none' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          },
          '.cm-content': { padding: '12px 16px' },
          '.cm-gutters': { display: 'none' },
        }),
      ],
    }),
    parent,
  });

  // Apply initial suggestion mode after construction so the StateField default
  // (false) gets overridden by the user's persisted choice.
  if (enableCriticMarkup && initialSuggestionMode) {
    view.dispatch({ effects: toggleSuggestionMode.of(true) });
  }

  // Bridge the criticmarkup plugin's `comment-badge-focus` CustomEvent (fired
  // when the user clicks a `cm-comment-badge` widget) into the React layer.
  // The event is dispatched on `document` with detail: { threadFrom: number }.
  // Translate the local CodeMirror position to an absolute Y.Text position by
  // adding the section's start offset.
  if (enableCriticMarkup && onCommentBadgeClick) {
    const handler = (e: Event) => {
      const localFrom = (e as CustomEvent<{ threadFrom: number }>).detail?.threadFrom;
      if (localFrom != null) {
        onCommentBadgeClick(sectionFrom + localFrom);
      }
    };
    document.addEventListener('comment-badge-focus', handler);
    // Tear down with the view so we don't leak the listener if anything
    // else holds onto view.dom longer than expected.
    const origDestroy = view.destroy.bind(view);
    view.destroy = () => {
      document.removeEventListener('comment-badge-focus', handler);
      origDestroy();
    };
  }

  return view;
}
