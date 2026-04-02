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
vi.mock('./claude');
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
      expect.stringContaining('processing')
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
});
