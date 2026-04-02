/** Raw transcript event from YouTube's fmt=json3 response */
export interface TranscriptEvent {
  tStartMs: number;
  dDurationMs: number;
  segs?: TranscriptSegment[];
  wWinId?: number;
  aAppend?: number;
}

export interface TranscriptSegment {
  utf8: string;
  tOffsetMs?: number;
  acAsrConf?: number;
}

/** Full fmt=json3 response from YouTube */
export interface TranscriptRaw {
  events: TranscriptEvent[];
  wireMagic?: string;
}

/** Single video payload from the bookmarklet */
export interface VideoPayload {
  video_id: string;
  title: string;
  channel: string;
  url: string;
  transcript_type: 'word_level' | 'sentence_level';
  transcript_raw: TranscriptRaw;
}

/** A word with its timestamp in seconds */
export interface TimestampedWord {
  text: string;
  start: number;
}

/** Final timestamps.json entry with M:SS.mm format */
export interface FormattedTimestamp {
  text: string;
  start: string;
}

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface Job {
  id: string;
  video_id: string;
  title: string;
  channel: string;
  url: string;
  transcript_type: 'word_level' | 'sentence_level';
  status: JobStatus;
  error?: string;
  relay_url?: string;
  created_at: string;
  updated_at: string;
}
