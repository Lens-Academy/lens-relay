import { useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';

function preserveBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, (match) => {
    const extras = match.length - 1;
    return '\n\n' + '\u00A0\n\n'.repeat(extras);
  });
}
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

      // Extract title/channel from frontmatter
      const titleMatch = transcriptText.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const channelMatch = transcriptText.match(/^channel:\s*"?([^"\n]+)"?\s*$/m);
      if (titleMatch) {
        const t = titleMatch[1].trim();
        const ch = channelMatch ? channelMatch[1].trim() : null;
        setVideoTitle(ch ? `${t} — ${ch}` : t);
      } else {
        const fallback = videoSourceWikilink
          .replace(/^!?\[\[/, '').replace(/\]\]$/, '')
          .split('/').pop()?.split('|')[0] ?? 'Video';
        setVideoTitle(fallback);
      }

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

  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const handleClick = useCallback((e: React.MouseEvent) => {
    setTooltip({ x: e.clientX, y: e.clientY });
    setTimeout(() => setTooltip(null), 3000);
  }, []);

  return (
    <div className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
      style={{ background: 'rgba(184, 112, 24, 0.04)' }}>
      <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
        <div className="text-[10px] uppercase tracking-wider text-teal-600 font-semibold mb-1">
          Video {fromTime && toTime ? `(${fromTime} – ${toTime})` : fromTime ? `(from ${fromTime})` : ''}
        </div>
        <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
          {videoTitle}
        </div>
        <div className="text-xs text-gray-400 mt-1 italic">
          Transcript shown below — the student watches the video
        </div>
      </div>
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 text-xs text-amber-800 bg-amber-50 rounded-lg border border-amber-200 shadow-md"
          style={{ left: tooltip.x + 8, top: tooltip.y - 10, maxWidth: '280px' }}
        >
          To edit this video transcript, go to the source file.
        </div>
      )}
      <div className="px-6 py-5 cursor-pointer" onClick={handleClick}>
        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
        )}
        {!error && !excerptText && (
          <div className="text-sm text-gray-400 italic">Loading transcript...</div>
        )}
        {!error && excerptText && (
          <>
            <div className="text-gray-400 tracking-wider mb-1">&hellip;</div>
            <div className="text-[13px] leading-[1.5] text-gray-700" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              <ReactMarkdown remarkPlugins={[remarkBreaks]}>{preserveBlankLines(excerptText)}</ReactMarkdown>
            </div>
            <div className="text-gray-400 tracking-wider mt-1">&hellip;</div>
          </>
        )}
      </div>
    </div>
  );
}
