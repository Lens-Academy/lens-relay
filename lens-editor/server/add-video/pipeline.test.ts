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
    mockClaude.runClaude.mockImplementation(async () => {
      callOrder.push('claude');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await runImport();

    expect(mockRelayDocs.createRelayDoc).toHaveBeenCalledWith(
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
    expect(mockRelayDocs.createRelayDoc).toHaveBeenCalledWith(
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

    expect(mockRelayDocs.createRelayDoc).toHaveBeenCalledWith(
      expect.stringContaining('.md'),
      expect.stringContaining('hello world'),
      undefined
    );
    expect(mockRelayDocs.updateRelayDoc).not.toHaveBeenCalled();
  });

  // Prevents a regression to the old "Transcript processing failed" doc, which
  // both destroyed a usable transcript and (when it carried a watch?v= url)
  // tripped the relay's video-id dedup scan, blocking every resubmission.
  it('never replaces the transcript with a failure doc', async () => {
    mockClaude.runClaude.mockRejectedValue(new Error('claude exploded'));

    await expect(runImport()).resolves.toBeUndefined();

    const wrote = [
      ...mockRelayDocs.createRelayDoc.mock.calls,
      ...mockRelayDocs.updateRelayDoc.mock.calls,
    ].map((c) => String(c[c.length - 2]));
    expect(wrote.some((c) => c.includes('processing failed'))).toBe(false);
  });
});
