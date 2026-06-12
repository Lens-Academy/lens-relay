import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

function waitForExpectation(assertion: () => void): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    function check() {
      try {
        assertion();
        resolveWait();
      } catch (error) {
        if (Date.now() - started > 1000) {
          reject(error);
        } else {
          setTimeout(check, 10);
        }
      }
    }
    check();
  });
}

async function runBookmarkletOn(url: string) {
  const window = new Window({ url });
  const document = window.document;
  document.body.innerHTML = [
    '<script>',
    JSON.stringify({
      INNERTUBE_API_KEY: 'test-key',
      INNERTUBE_CLIENT_VERSION: 'test-client',
      VISITOR_DATA: 'test-visitor',
    }),
    '</script>',
  ].join('');

  const script = await readFile(
    resolve(process.cwd(), 'public/add-video-bookmarklet.js'),
    'utf8',
  );
  window.eval(
    script
      .replace('__LENS_ADD_VIDEO_TOKEN__', 'test-token')
      .replace('__LENS_SERVER_URL__', 'https://editor.example'),
  );

  return { window, document };
}

describe('add-video bookmarklet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubYouTubeAndAddVideoFetch() {
    return vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          videoDetails: {
            title: 'Video title',
            author: 'Video channel',
          },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [{
                languageCode: 'en',
                kind: 'asr',
                baseUrl: 'https://youtube.example/transcript',
              }],
            },
          },
        }));
      }
      if (url.startsWith('https://youtube.example/transcript')) {
        return new Response(JSON.stringify({
          events: [{
            tStartMs: 0,
            dDurationMs: 1000,
            segs: [{ utf8: 'hello' }],
          }],
        }));
      }
      if (url.includes('/api/add-video')) {
        return new Response(JSON.stringify({
          results: [{ title: 'Video title', status: 'queued' }],
        }));
      }
      return new Response('unexpected fetch: ' + url, { status: 500 });
    });
  }

  async function submitImportedVideos(
    document: any,
    fetchMock: ReturnType<typeof vi.fn>,
  ) {
    document.getElementById('lens-av-fetch').onclick({});

    await waitForExpectation(() => {
      expect(document.querySelector('.lens-av-job.done')).toBeTruthy();
    });

    const confirmButton = document.getElementById('lens-av-confirm');
    confirmButton.onclick({});

    await waitForExpectation(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/add-video'))).toBe(true);
    });

    const addVideoCall = fetchMock.mock.calls.find(
      ([input]) => String(input).includes('/api/add-video'),
    )!;
    return JSON.parse(String(addVideoCall[1]?.body));
  }

  it('sends a full Shorts URL when importing a Shorts URL', async () => {
    const fetchMock = stubYouTubeAndAddVideoFetch();
    const { window, document } = await runBookmarkletOn('https://www.youtube.com/shorts/GMTDrG3hYJ0');
    (window as any).fetch = fetchMock;

    const body = await submitImportedVideos(document, fetchMock);

    expect(body.videos[0].url).toBe('https://www.youtube.com/shorts/GMTDrG3hYJ0');
  });

  // Prevents: YouTube's attestation enforcement on WEB-client /player calls
  // (returns UNPLAYABLE with captionTracks stripped even when the watch page
  // shows captions) aborting imports with "No captions available" — the
  // ANDROID client fallback must kick in and its srv3 XML captions must be
  // converted to the json3 events shape the server expects.
  it('falls back to the ANDROID client and converts srv3 XML when WEB strips captions', async () => {
    const srv3Xml = [
      '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">',
      '<head><ws id="0"/><wp id="0"/></head>',
      '<body>',
      '<w t="0" id="1"/>',
      '<p t="0" d="2510" w="1">[Music]</p>',
      '<p t="4390" w="1" a="1">',
      '</p>',
      '<p t="4400" d="4159" w="1"><s ac="0">This</s><s t="399" ac="0"> is</s><s t="560" ac="0"> a</s></p>',
      '</body>',
      '</timedtext>',
    ].join('\n');

    const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) {
        const clientName = JSON.parse(init?.body ?? '{}')?.context?.client?.clientName;
        if (clientName === 'WEB') {
          return new Response(JSON.stringify({
            playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' },
            videoDetails: { title: 'Video title', author: 'Video channel' },
          }));
        }
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          videoDetails: { title: 'Video title', author: 'Video channel' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [{
                languageCode: 'en',
                kind: 'asr',
                baseUrl: 'https://youtube.example/android-transcript',
              }],
            },
          },
        }));
      }
      if (url.startsWith('https://youtube.example/android-transcript')) {
        return new Response(srv3Xml);
      }
      if (url.includes('/api/add-video')) {
        return new Response(JSON.stringify({
          results: [{ title: 'Video title', status: 'queued' }],
        }));
      }
      return new Response('unexpected fetch: ' + url, { status: 500 });
    });

    const { window, document } = await runBookmarkletOn('https://www.youtube.com/watch?v=GMTDrG3hYJ0');
    (window as any).fetch = fetchMock;

    const body = await submitImportedVideos(document, fetchMock);

    expect(body.videos[0].transcript_type).toBe('word_level');
    expect(body.videos[0].transcript_raw.events).toEqual([
      { tStartMs: 0, dDurationMs: 2510, segs: [{ utf8: '[Music]' }] },
      {
        tStartMs: 4400,
        dDurationMs: 4159,
        segs: [
          { utf8: 'This' },
          { utf8: ' is', tOffsetMs: 399 },
          { utf8: ' a', tOffsetMs: 560 },
        ],
      },
    ]);
  });

  // Prevents: playability failures being misreported as "No captions
  // available" — the error shown to the user must carry YouTube's actual
  // playability status so real no-caption videos stay distinguishable.
  it('surfaces the playability reason when both clients fail', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' },
        }));
      }
      return new Response('unexpected fetch: ' + url, { status: 500 });
    });

    const { window, document } = await runBookmarkletOn('https://www.youtube.com/watch?v=GMTDrG3hYJ0');
    (window as any).fetch = fetchMock;

    (document.getElementById('lens-av-fetch') as any).onclick({});

    await waitForExpectation(() => {
      expect(document.querySelector('.lens-av-job.error')).toBeTruthy();
    });

    const detail = document.querySelector('.lens-av-job.error .lens-av-job-detail')!.textContent;
    expect(detail).toContain('LOGIN_REQUIRED');
    expect(detail).toContain('Sign in to confirm your age');
  });

  it('sends full normal URLs and prefers Shorts when duplicate inputs use the same video ID', async () => {
    const fetchMock = stubYouTubeAndAddVideoFetch();
    const { window, document } = await runBookmarkletOn('https://www.youtube.com/watch?v=GMTDrG3hYJ0');
    (window as any).fetch = fetchMock;
    const textarea = document.getElementById('lens-av-urls') as any;
    textarea.value = [
      'https://www.youtube.com/watch?v=GMTDrG3hYJ0',
      'https://www.youtube.com/shorts/GMTDrG3hYJ0',
    ].join('\n');

    const body = await submitImportedVideos(document, fetchMock);

    expect(body.videos).toHaveLength(1);
    expect(body.videos[0].url).toBe('https://www.youtube.com/shorts/GMTDrG3hYJ0');
  });
});
