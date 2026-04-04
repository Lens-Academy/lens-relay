import { useState, useEffect } from 'react';

export function AddVideoPage({ shareToken }: { shareToken: string }) {
  const [bookmarkletHref, setBookmarkletHref] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      try {
        // 1. Get add-video token from server
        const tokenResp = await fetch('/api/add-video/install-token', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${shareToken}` },
        });
        if (!tokenResp.ok) {
          const data = await tokenResp.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error || `Failed to get install token: ${tokenResp.status}`);
        }
        const { token } = await tokenResp.json() as { token: string };

        // 2. Fetch bookmarklet JS
        const jsResp = await fetch('/add-video-bookmarklet.js');
        if (!jsResp.ok) throw new Error('Failed to load bookmarklet script');
        let js = await jsResp.text();

        // 3. Inject server URL and token
        js = js.replaceAll('__LENS_SERVER_URL__', window.location.origin);
        js = js.replaceAll('__LENS_ADD_VIDEO_TOKEN__', token);

        if (!cancelled) {
          setBookmarkletHref('javascript:' + encodeURIComponent(js));
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    setup();
    return () => { cancelled = true; };
  }, [shareToken]);

  useEffect(() => {
    document.title = 'Add Video to Lens';
    return () => { document.title = 'Editor'; };
  }, []);

  return (
    <div style={{ background: '#1a1a2e', minHeight: '100%', color: '#e0e0e0', fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '60px 20px' }}>
        <h1 style={{ color: '#fff' }}>Add Video to Lens</h1>
        <p>Add YouTube video transcripts to the Lens library with one click.</p>

        <h2 style={{ color: '#fff' }}>Install</h2>
        <p>Drag this button to your bookmarks bar:</p>

        {error ? (
          <div style={{ background: '#2a0e0e', borderLeft: '3px solid #e04e4e', padding: 12, borderRadius: 4, margin: '16px 0', fontSize: 13 }}>
            Error: {error}
          </div>
        ) : bookmarkletHref ? (
          <a
            href={bookmarkletHref}
            style={{
              display: 'inline-block',
              background: '#4361ee',
              color: 'white',
              padding: '12px 24px',
              borderRadius: 8,
              textDecoration: 'none',
              fontSize: 16,
              fontWeight: 500,
              margin: '20px 0',
              cursor: 'grab',
            }}
            onMouseOver={e => (e.currentTarget.style.background = '#3a56d4')}
            onMouseOut={e => (e.currentTarget.style.background = '#4361ee')}
          >
            Add to Lens
          </a>
        ) : (
          <div style={{ color: '#888', margin: '20px 0', fontSize: 14 }}>Loading bookmarklet...</div>
        )}

        <div style={{ background: '#2a1a0e', borderLeft: '3px solid #f0ad4e', padding: 12, borderRadius: 4, margin: '16px 0', fontSize: 13 }}>
          If your bookmarks bar is hidden, press <code style={{ background: '#0f0f23', padding: '2px 6px', borderRadius: 4, fontSize: 13 }}>Ctrl+Shift+B</code> (Windows/Linux) or <code style={{ background: '#0f0f23', padding: '2px 6px', borderRadius: 4, fontSize: 13 }}>Cmd+Shift+B</code> (Mac) to show it.
        </div>

        <h2 style={{ color: '#fff' }}>Usage</h2>

        {[
          'Go to any YouTube page (a video, your homepage, etc.)',
          <span>Click the <strong>"Add to Lens"</strong> bookmark in your bookmarks bar</span>,
          'A panel opens on the right. Paste one or more YouTube video URLs (one per line), or leave it pre-filled with the current video.',
          <span>Click <strong>"Fetch Transcripts"</strong> &mdash; the bookmarklet extracts transcripts with word-level timestamps directly from YouTube.</span>,
          <span>Review the results, then click <strong>"Send to Lens"</strong> to queue them for processing.</span>,
        ].map((text, i) => (
          <div key={i} style={{ background: '#16213e', borderRadius: 8, padding: 16, margin: '12px 0' }}>
            <span style={{ display: 'inline-block', background: '#4361ee', color: 'white', width: 28, height: 28, borderRadius: '50%', textAlign: 'center', lineHeight: '28px', fontWeight: 'bold', marginRight: 8 }}>
              {i + 1}
            </span>
            {text}
          </div>
        ))}

        <div style={{ background: '#2a1a0e', borderLeft: '3px solid #f0ad4e', padding: 12, borderRadius: 4, margin: '16px 0', fontSize: 13 }}>
          Transcripts are queued for processing on the server. You can check status at{' '}
          <code style={{ background: '#0f0f23', padding: '2px 6px', borderRadius: 4, fontSize: 13 }}>/api/add-video/status</code>.
        </div>
      </div>
    </div>
  );
}
