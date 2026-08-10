import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processVideo } from './pipeline';
import type { Job, VideoPayload } from './types';
import * as fs from 'node:fs/promises';
import * as claude from './claude';
import * as relayDocs from './relay-docs';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
// Partial mock: runClaude is stubbed, but summarizeClaudeOutcome stays real so
// error-propagation tests exercise the actual summary formatting.
vi.mock('./claude', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude')>();
  return { ...actual, runClaude: vi.fn() };
});
vi.mock('./relay-docs');

const mockFs = vi.mocked(fs);
const mockClaude = vi.mocked(claude);
const mockRelayDocs = vi.mocked(relayDocs);

const makeJobWithPayload = (): Job & { payload: VideoPayload } => ({
  id: 'test-job',
  video_id: 'abc123',
  title: 'Test Video',
  channel: 'TestChannel',
  url: 'https://www.youtube.com/watch?v=abc123',
  transcript_type: 'word_level',
  status: 'processing',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  payload: {
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
          segs: [
            { utf8: 'hello' },
            { utf8: ' world', tOffsetMs: 500 },
          ],
        },
      ],
    },
  },
});

describe('processVideo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue('Hello world.');
    mockFs.rm.mockResolvedValue(undefined);
    mockClaude.runClaude.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockRelayDocs.createRelayDoc.mockResolvedValue(undefined);
    mockRelayDocs.updateRelayDoc.mockResolvedValue(undefined);
  });

  it('creates work directory and writes raw files', async () => {
    await processVideo(makeJobWithPayload());

    expect(mockFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      { recursive: true }
    );
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('raw.json'),
      expect.any(String)
    );
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('raw.txt'),
      expect.any(String)
    );
  });

  it('creates placeholder doc in relay before processing', async () => {
    await processVideo(makeJobWithPayload());

    expect(mockRelayDocs.createRelayDoc).toHaveBeenCalledWith(
      expect.stringContaining('Lens Edu/video_transcripts/'),
      expect.stringContaining('processed')
    );
  });

  it('invokes claude on the work directory', async () => {
    await processVideo(makeJobWithPayload());

    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      expect.any(Number)
    );
  });

  it('updates relay doc with final content after processing', async () => {
    await processVideo(makeJobWithPayload());

    // Should have called updateRelayDoc to replace placeholder
    expect(mockRelayDocs.updateRelayDoc).toHaveBeenCalled();
  });

  it('cleans up work directory after processing', async () => {
    await processVideo(makeJobWithPayload());

    expect(mockFs.rm).toHaveBeenCalledWith(
      expect.stringContaining('test-job'),
      { recursive: true }
    );
  });

  it('updates relay doc with failure on claude error', async () => {
    mockClaude.runClaude.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'failed' });

    await expect(processVideo(makeJobWithPayload())).rejects.toThrow();
  });

  it('propagates claude stdout JSON detail on nonzero exit', async () => {
    mockClaude.runClaude.mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({
        subtype: 'error_max_budget_usd',
        is_error: true,
        result: 'Budget exceeded',
      }),
      stderr: '',
    });

    await expect(processVideo(makeJobWithPayload())).rejects.toThrow(
      /error_max_budget_usd.*Budget exceeded/,
    );
  });

  it('reports a clear error when claude exits 0 without writing corrected.txt', async () => {
    mockClaude.runClaude.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ subtype: 'success', result: 'I cannot help with that.' }),
      stderr: '',
    });
    const enoent = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
    });
    mockFs.readFile.mockRejectedValue(enoent);

    await expect(processVideo(makeJobWithPayload())).rejects.toThrow(
      /wrote no corrected\.txt.*I cannot help with that/,
    );
  });

  it('writes the failure reason into the failure placeholder', async () => {
    mockClaude.runClaude.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'API error 429: rate limited',
    });

    await expect(processVideo(makeJobWithPayload())).rejects.toThrow();

    // The only updateRelayDoc call on the failure path is the placeholder update.
    const [, , content] = mockRelayDocs.updateRelayDoc.mock.lastCall!;
    expect(content).toContain('Transcript processing failed');
    expect(content).toContain('Error: Claude exited with code 1');
    expect(content).toContain('rate limited');
  });
});
