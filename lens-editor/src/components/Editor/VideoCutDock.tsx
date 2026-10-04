import { useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { useDocConnection } from '../../hooks/useDocConnection';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields } from '../../lib/parseFields';
import { parseTime } from '../../lib/videoCuts';
import { resolvePending, segmentTimeEdit } from '../../lib/segmentTime';
import { getCurrentAuthor, suggestionModeField } from './extensions/criticmarkup';
import { loadVideoSource, type VideoSource } from '../../lib/videoSource';
import type { VideoCutLine } from './extensions/videoCutButtons';
import { CutPicker } from './CutPicker';

interface VideoCutDockProps {
  view: EditorView;
  target: VideoCutLine;
  /** Bumped on every document change, so the shown from/to stay current. */
  docVersion: number;
  metadata: FolderMetadata;
  currentFilePath: string;
  readOnly: boolean;
  onClose: () => void;
}

/** The cut picker for one video segment, docked under the File Editor. */
export function VideoCutDock({ view, target, docVersion, metadata, currentFilePath, readOnly, onClose }: VideoCutDockProps) {
  const { getOrConnect } = useDocConnection();
  const [source, setSource] = useState<VideoSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadVideoSource(target.source, currentFilePath, metadata, getOrConnect)
      .then((s) => {
        if (cancelled) return;
        setError(s.videoId ? null : 'This transcript has no YouTube url: to play.');
        setSource(s);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // metadata changes on every folder sync; the source only needs loading once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.source, currentFilePath, getOrConnect]);

  // The segment's times as they are in the document now
  void docVersion;
  const section = parseSections(view.state.doc.toString())[target.sectionIndex];
  const fields = section?.type === 'video' ? parseFields(section.content) : null;
  // A time with a pending suggestion reads as if it were accepted
  const time = (name: string) => {
    const raw = fields?.get(name);
    return raw ? parseTime(resolvePending(raw, 'accept')) : null;
  };
  const from = time('from');
  const to = time('to');

  const use = (field: 'from' | 'to', value: string) => {
    const doc = view.state.doc.toString();
    const edit = segmentTimeEdit(doc, target.sectionIndex, field, value);
    if (!edit) return;
    const old = doc.slice(edit.index, edit.index + edit.deleteCount);
    if (!old.includes('{')) {
      // A user edit, so suggestion mode turns it into a suggestion
      view.dispatch({
        changes: { from: edit.index, to: edit.index + edit.deleteCount, insert: edit.insert },
        userEvent: 'input.videocut',
      });
      return;
    }
    // The time already carries a suggestion. Suggesting again replaces it
    // with one suggestion from the live time to this one, rather than
    // nesting markup; an editor sets the time outright.
    const live = resolvePending(old, 'reject');
    // Choosing the live time again just drops the pending suggestion
    const insert = view.state.field(suggestionModeField, false) && live !== value
      ? `{~~${JSON.stringify({ author: getCurrentAuthor(), timestamp: Date.now() })}@@${live}~>${value}~~}`
      : value;
    view.dispatch({ changes: { from: edit.index, to: edit.index + edit.deleteCount, insert } });
  };

  return (
    <div className="shrink-0 max-h-[55%] overflow-auto border-t border-gray-200 bg-gray-50 shadow-[0_-2px_6px_rgba(0,0,0,0.04)]" data-testid="video-cut-dock">
      {!fields ? (
        <Message text="This video segment is gone." onClose={onClose} />
      ) : error ? (
        <Message text={error} onClose={onClose} />
      ) : !source?.videoId ? (
        <Message text="Loading the video…" onClose={onClose} />
      ) : (
        <CutPicker
          key={`${target.sectionIndex}-${target.field}`}
          videoId={source.videoId}
          words={source.words}
          title={source.title}
          from={from ?? 0}
          to={to}
          initialField={target.field}
          onUse={readOnly ? undefined : use}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function Message({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="flex items-center px-6 py-3 text-sm text-gray-500">
      {text}
      <button onClick={onClose} className="ml-auto text-xs text-gray-400 hover:text-gray-700">
        Close
      </button>
    </div>
  );
}
