import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useDocConnection } from '../../hooks/useDocConnection';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { fetchBlobContent } from '../../lib/fetchBlob';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';

interface VideoExcerptEmbedProps {
  fromTime?: string;
  toTime?: string;
  videoSourceWikilink: string;
  lensSourcePath: string;
}

export function VideoExcerptEmbed({ fromTime, toTime, videoSourceWikilink, lensSourcePath }: VideoExcerptEmbedProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [excerptText, setExcerptText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState<string>('Video');

  useEffect(() => {
    const name = videoSourceWikilink
      .replace(/^!?\[\[/, '').replace(/\]\]$/, '')
      .split('/').pop()?.split('|')[0] ?? 'Video';
    setVideoTitle(name);
  }, [videoSourceWikilink]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Resolve transcript doc
      const transcriptUuid = resolveWikilinkToUuid(videoSourceWikilink, lensSourcePath, metadata);
      if (!transcriptUuid) {
        setError(`Could not resolve transcript: ${videoSourceWikilink}`);
        return;
      }

      // Connect to transcript doc
      const transcriptCompoundId = `${RELAY_ID}-${transcriptUuid}`;
      const { doc: transcriptDoc } = await getOrConnect(transcriptCompoundId);
      if (cancelled) return;

      const transcriptText = transcriptDoc.getText('contents').toString();

      // Try to find and load timestamps.json (stored as blob, not Y.Doc)
      const transcriptPath = Object.entries(metadata).find(([, m]) => m.id === transcriptUuid)?.[0];
      let timestamps: Array<{ text: string; start: string }> | undefined;

      if (transcriptPath) {
        const tsPath = transcriptPath.replace(/\.md$/, '.timestamps.json');
        const tsEntry = metadata[tsPath] as { id: string; hash?: string } | undefined;

        if (tsEntry?.hash) {
          try {
            const tsDocId = `${RELAY_ID}-${tsEntry.id}`;
            const text = await fetchBlobContent(tsDocId, tsEntry.hash);
            if (cancelled) return;
            timestamps = JSON.parse(text);
          } catch {
            // Fall back to inline timestamp extraction
          }
        }
      }

      // Both from and to are required by extractVideoExcerpt
      const from = fromTime ?? '0:00';
      const to = toTime;
      if (!to) {
        // Without a to timestamp, show the full transcript from the start point
        setExcerptText(transcriptText);
        return;
      }

      // Extract excerpt
      const { extractVideoExcerpt } = await import('lens-content-processor/dist/bundler/video.js');
      const result = extractVideoExcerpt(transcriptText, from, to, 'video', timestamps);

      if (cancelled) return;

      if (result.error) {
        setError(result.error.message);
      } else if (result.transcript) {
        setExcerptText(result.transcript);
      }
    }

    setExcerptText(null);
    setError(null);
    load();
    return () => { cancelled = true; };
  }, [videoSourceWikilink, lensSourcePath, fromTime, toTime, metadata, getOrConnect]);

  return (
    <div className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
      style={{ background: 'rgba(184, 112, 24, 0.04)' }}>
      <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
        <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
          {videoTitle}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Video transcript {fromTime && `from ${fromTime}`} {toTime && `to ${toTime}`}
        </div>
      </div>
      <div className="px-6 py-5">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
        )}
        {!error && !excerptText && (
          <div className="text-sm text-gray-400 italic">Loading transcript...</div>
        )}
        {!error && excerptText && (
          <>
            <div className="text-gray-400 tracking-wider mb-1">&hellip;</div>
            <div className="text-[14px] leading-[1.8] text-gray-700" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              <ReactMarkdown>{excerptText}</ReactMarkdown>
            </div>
            <div className="text-gray-400 tracking-wider mt-1">&hellip;</div>
          </>
        )}
      </div>
    </div>
  );
}
