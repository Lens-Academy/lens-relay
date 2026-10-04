import { useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { useDocConnection } from '../../hooks/useDocConnection';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';
import { parseTime } from '../../lib/videoCuts';
import { segmentFields, segmentTimeChange, type SegmentTimeField } from '../../lib/segmentTime';
import { loadVideoSource, type VideoSource } from '../../lib/videoSource';
import { videoSegments } from './extensions/videoCutButtons';
import { getCurrentAuthor, suggestionModeField } from './extensions/criticmarkup';
import { CutPicker } from './CutPicker';

interface VideoCutDockProps {
  view: EditorView;
  field: SegmentTimeField;
  /** The segment's heading start, kept current through edits. */
  anchor: number;
  /** Bumped on every document change, so the shown from/to stay current. */
  docVersion: number;
  /** Changes with each Tune click. */
  opened: number;
  metadata: FolderMetadata;
  currentFilePath: string;
  readOnly: boolean;
  onClose: () => void;
}

/** The cut picker for one video segment, docked under the File Editor. */
export function VideoCutDock({
  view,
  field,
  anchor,
  docVersion,
  opened,
  metadata,
  currentFilePath,
  readOnly,
  onClose,
}: VideoCutDockProps) {
  const { getOrConnect } = useDocConnection();
  // Keyed by the source it was loaded for, so a switch to a segment with
  // another video never shows the previous one
  const [loaded, setLoaded] = useState<{ key: string; source?: VideoSource; error?: string } | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // The segment as it is in the document now
  void docVersion;
  const segment = videoSegments(view.state.doc.toString()).find(
    ({ section }) => section.from <= anchor && anchor < Math.max(section.to, section.from + 1),
  );
  const sourceLink = segment?.source ?? null;
  const fields = segment ? segmentFields(segment.section) : null;
  const time = (name: SegmentTimeField) => {
    const raw = fields?.get(name);
    return raw ? parseTime(raw) : null;
  };

  useEffect(() => {
    if (!sourceLink) return;
    let cancelled = false;
    loadVideoSource(sourceLink, currentFilePath, metadata, getOrConnect)
      .then((source) => {
        if (cancelled) return;
        setLoaded({
          key: sourceLink,
          source,
          error: source.videoId ? undefined : 'This transcript has no YouTube url: to play.',
        });
      })
      .catch((e: Error) => !cancelled && setLoaded({ key: sourceLink, error: e.message }));
    return () => {
      cancelled = true;
    };
    // metadata changes on every folder sync; the source only needs loading once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLink, currentFilePath, getOrConnect]);

  const use = (which: SegmentTimeField, value: string) => {
    const now = videoSegments(view.state.doc.toString()).find(({ section }) => section.from === segment?.section.from);
    if (!now) return;
    const suggesting = view.state.field(suggestionModeField, false);
    const change = segmentTimeChange(now.section, which, value, {
      suggest: suggesting ? { author: getCurrentAuthor(), timestamp: Date.now() } : undefined,
    });
    if ('error' in change) {
      setWriteError(change.error);
      return;
    }
    setWriteError(null);
    // Suggesting: the markup is already written, so no userEvent, which
    // keeps the editor's suggestion filter from wrapping it again
    view.dispatch(suggesting ? { changes: change } : { changes: change, userEvent: 'input.videocut' });
  };

  const current = loaded && loaded.key === sourceLink ? loaded : null;

  return (
    <div
      className="shrink-0 max-h-[65%] overflow-auto border-t border-gray-200 bg-gray-50 shadow-[0_-2px_6px_rgba(0,0,0,0.04)]"
      data-testid="video-cut-dock"
    >
      {!segment ? (
        <Message text="This video segment is gone." onClose={onClose} />
      ) : current?.error ? (
        <Message text={current.error} onClose={onClose} />
      ) : !current?.source?.videoId ? (
        <Message text="Loading the video…" onClose={onClose} />
      ) : (
        <>
          {writeError && <div className="px-6 pt-3 text-xs text-red-600">{writeError}</div>}
          <CutPicker
            key={`${opened}-${current.key}`}
            videoId={current.source.videoId}
            words={current.source.words}
            title={current.source.title}
            from={time('from') ?? 0}
            to={time('to')}
            initialField={field}
            onUse={readOnly ? undefined : use}
            onClose={onClose}
          />
        </>
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
