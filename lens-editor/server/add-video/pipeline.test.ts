import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importVideo } from './pipeline';
import type { VideoPayload } from './types';
import * as fs from 'node:fs/promises';
import * as claude from './claude';
import * as relayDocs from './relay-docs';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('./claude');
vi.mock('./relay-docs');

const mockFs = vi.mocked(fs);
const mockClaude = vi.mocked(claude);
const mockRelayDocs = vi.mocked(relayDocs);

const makePayload = (): VideoPayload => ({
  video_id: 'abc123',
  title: 'Test Video',
  channel: 'TestChannel',
  url: 'https://www.youtube.com/watch?v=abc123',
  transcript_type: 'word_level',
  transcript_raw: {
    events: [
      {
        tStartMs: 0,
        dDurationMs: 1000,
        segs: [{ utf8: 'hello' }, { utf8: ' world', tOffsetMs: 500 }],
      },
    ],
  },
});

const runImport = () =>
  importVideo('test-job', makePayload(), new Date().toISOString(), {
    createLens: false,
  });

describe('importVideo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue('Hello world.');
    mockFs.rm.mockResolvedValue(undefined);
    mockClaude.runClaude.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockRelayDocs.createRelayDoc.mockResolvedValue(undefined);
    mockRelayDocs.updateRelayDoc.mockResolvedValue(undefined);
    // Model the real round-trip: what we publish is what reads back, so the
    // cleanup's "was this edited?" guard sees an untouched document.
    let published = '';
    mockRelayDocs.upsertRelayDocReturningId.mockImplementation(
      async (_path: string, content: string) => {
        published = content;
        return 'doc-1';
      }
    );
    mockRelayDocs.readRelayDocText.mockImplementation(async () => published);
    mockRelayDocs.relayTranscriptFolder.mockReturnValue(
      'Lens Edu/video_transcripts'
    );
    mockRelayDocs.editorOpenUrl.mockImplementation(
      (p: string) => `https://editor.lensacademy.org/open/${encodeURI(p)}`
    );
  });

  it('creates work directory and writes the plain-text transcript', async () => {
    await runImport();

    expect(mockFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      { recursive: true }
    );
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('raw.txt'),
      expect.any(String)
    );
  });

  // The reader gets a usable transcript immediately; the cleanup pass edits it
  // afterwards. Publishing must not wait behind the LLM.
  it('publishes the real transcript before running cleanup', async () => {
    const callOrder: string[] = [];
    mockRelayDocs.createRelayDoc.mockImplementation(async (p: string) => {
      callOrder.push(`create:${p.endsWith('.json') ? 'timestamps' : 'md'}`);
    });
    mockRelayDocs.upsertRelayDocReturningId.mockImplementation(async () => {
      callOrder.push('create:md');
      return 'doc-1';
    });
    mockClaude.runClaude.mockImplementation(async () => {
      callOrder.push('claude');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await runImport();

    expect(mockRelayDocs.upsertRelayDocReturningId).toHaveBeenCalledWith(
      expect.stringContaining('Lens Edu/video_transcripts/'),
      expect.stringContaining('hello world'),
      undefined
    );
    // Both the doc and its timestamps land before Claude is ever invoked.
    expect(callOrder.indexOf('claude')).toBeGreaterThan(
      callOrder.indexOf('create:timestamps')
    );
    expect(callOrder.indexOf('create:md')).toBeLessThan(
      callOrder.indexOf('claude')
    );
  });

  // Human-written captions already have punctuation and casing, so the cleanup
  // pass costs latency and money to change essentially nothing.
  it('skips the cleanup pass entirely for human-written captions', async () => {
    await importVideo(
      'test-job',
      { ...makePayload(), transcript_type: 'sentence_level' },
      new Date().toISOString(),
      { createLens: false }
    );

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockRelayDocs.upsertRelayDocReturningId).toHaveBeenCalledWith(
      expect.stringContaining('.md'),
      expect.stringContaining('hello world'),
      undefined
    );
  });

  it('invokes claude on the work directory', async () => {
    await runImport();

    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      expect.any(Number),
      undefined
    );
  });

  it('updates relay doc with final content after processing', async () => {
    await runImport();

    // Should have called updateRelayDoc to replace placeholder
    expect(mockRelayDocs.updateRelayDoc).toHaveBeenCalled();
  });

  it('cleans up work directory after processing', async () => {
    await runImport();

    expect(mockFs.rm).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      { recursive: true }
    );
  });

  // A failed cleanup is not a failed import: the published transcript is
  // already faithful, so the job succeeds and the doc is left untouched.
  it('keeps the published transcript when cleanup fails', async () => {
    mockClaude.runClaude.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'failed' });

    await expect(runImport()).resolves.toBeUndefined();

    expect(mockRelayDocs.upsertRelayDocReturningId).toHaveBeenCalledWith(
      expect.stringContaining('.md'),
      expect.stringContaining('hello world'),
      undefined
    );
    expect(mockRelayDocs.updateRelayDoc).not.toHaveBeenCalled();
  });

  // Readers can edit the transcript while the cleanup is still running, and a
  // relay write replaces the whole document -- so the cleanup must yield.
  it('does not overwrite a transcript that was edited while cleanup ran', async () => {
    mockRelayDocs.readRelayDocText.mockResolvedValue(
      '# Someone edited this by hand'
    );

    await expect(runImport()).resolves.toBeUndefined();

    expect(mockRelayDocs.updateRelayDoc).not.toHaveBeenCalled();
  });

  // A failed read must not block the cleanup: the common case is an untouched
  // document, and losing the polish over a transient relay hiccup is worse.
  it('still applies the cleanup when the document cannot be re-read', async () => {
    mockRelayDocs.readRelayDocText.mockRejectedValue(new Error('relay down'));

    await expect(runImport()).resolves.toBeUndefined();

    expect(mockRelayDocs.updateRelayDoc).toHaveBeenCalled();
  });

  // Prevents a regression to the old "Transcript processing failed" doc, which
  // both destroyed a usable transcript and (when it carried a watch?v= url)
  // tripped the relay's video-id dedup scan, blocking every resubmission.
  it('never replaces the transcript with a failure doc', async () => {
    mockClaude.runClaude.mockRejectedValue(new Error('claude exploded'));

    await expect(runImport()).resolves.toBeUndefined();

    const wrote = [
      ...mockRelayDocs.createRelayDoc.mock.calls,
      ...mockRelayDocs.upsertRelayDocReturningId.mock.calls,
      ...mockRelayDocs.updateRelayDoc.mock.calls,
    ].map((c) => String(c[c.length - 2]));
    expect(wrote.some((c) => c.includes('processing failed'))).toBe(false);
  });
});

describe('importVideo without captions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rm.mockResolvedValue(undefined);
    mockRelayDocs.createRelayDoc.mockResolvedValue(undefined);
    mockRelayDocs.updateRelayDoc.mockResolvedValue(undefined);
    // Model the real round-trip: what we publish is what reads back, so the
    // cleanup's "was this edited?" guard sees an untouched document.
    let published = '';
    mockRelayDocs.upsertRelayDocReturningId.mockImplementation(
      async (_path: string, content: string) => {
        published = content;
        return 'doc-1';
      }
    );
    mockRelayDocs.readRelayDocText.mockImplementation(async () => published);
    mockRelayDocs.relayTranscriptFolder.mockReturnValue(
      'Lens Edu/video_transcripts'
    );
    mockRelayDocs.editorOpenUrl.mockImplementation((p: string) => `url:${p}`);
  });

  // A caption-less video used to fail outright and write nothing. The document
  // and lens are what let a video be referenced from course content, so they
  // must exist even with no transcript.
  it('still creates the document and lens, and skips the empty timestamps file', async () => {
    const payload = {
      video_id: 'nocaps',
      title: 'Silent Video',
      channel: 'TestChannel',
      url: 'https://www.youtube.com/watch?v=nocaps',
      transcript_type: 'sentence_level' as const,
      transcript_raw: { events: [] },
    };

    await expect(
      importVideo('nocaps-job', payload, new Date().toISOString(), {
        createLens: false,
      })
    ).resolves.toBeUndefined();

    expect(mockRelayDocs.upsertRelayDocReturningId).toHaveBeenCalledWith(
      expect.stringContaining('.md'),
      expect.any(String),
      undefined
    );
    const paths = mockRelayDocs.createRelayDoc.mock.calls.map(([p]) => p);
    expect(paths.some((p) => p.endsWith('.timestamps.json'))).toBe(false);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });
});
