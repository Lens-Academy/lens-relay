import type * as Y from 'yjs';
import { resolveWikilinkToUuid } from './resolveDocPath';
import { fetchBlobContent } from './fetchBlob';
import { RELAY_ID } from './constants';
import { toWords, youtubeId, type TimedWord, type Word } from './videoCuts';

export interface VideoSource {
  videoId: string | null;
  title: string;
  /** Word timings from the transcript's `.timestamps.json`; null without one. */
  words: Word[] | null;
}

/**
 * What a video segment's `source::` points at: the YouTube id from the
 * transcript's `url:`, its title, and the word timings in the
 * `<transcript>.timestamps.json` sidecar next to it.
 */
export async function loadVideoSource(
  sourceWikilink: string,
  fromFile: string,
  metadata: Record<string, { id: string; hash?: string }>,
  getOrConnect: (docId: string) => Promise<{ doc: Y.Doc }>,
): Promise<VideoSource> {
  const transcriptUuid = resolveWikilinkToUuid(sourceWikilink, fromFile, metadata);
  if (!transcriptUuid) throw new Error(`Could not find the transcript ${sourceWikilink}`);

  const { doc } = await getOrConnect(`${RELAY_ID}-${transcriptUuid}`);
  const text = doc.getText('contents').toString();
  const field = (name: string) =>
    text.match(new RegExp(`^${name}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1].trim() ?? null;
  const url = field('url');

  let words: Word[] | null = null;
  const transcriptPath = Object.entries(metadata).find(([, m]) => m.id === transcriptUuid)?.[0];
  const sidecar = transcriptPath ? metadata[transcriptPath.replace(/\.md$/, '.timestamps.json')] : undefined;
  if (sidecar?.hash) {
    try {
      const timed = JSON.parse(await fetchBlobContent(`${RELAY_ID}-${sidecar.id}`, sidecar.hash)) as TimedWord[];
      if (Array.isArray(timed)) words = toWords(timed);
    } catch {
      // Without word timings the picker still works, only without a suggestion
    }
  }

  return { videoId: url ? youtubeId(url) : null, title: field('title') ?? 'Video', words };
}
