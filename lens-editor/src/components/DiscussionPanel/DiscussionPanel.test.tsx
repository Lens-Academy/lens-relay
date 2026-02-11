/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import * as Y from 'yjs';
import { DiscussionPanel } from './DiscussionPanel';
import { DisplayNameProvider } from '../../contexts/DisplayNameContext';
import messagesFixture from './__fixtures__/discord-messages.json';
import channelFixture from './__fixtures__/discord-channel.json';

// ---- Wrapper for context providers ----

function Wrapper({ children }: { children: React.ReactNode }) {
  return <DisplayNameProvider>{children}</DisplayNameProvider>;
}

// ---- EventSource mock (not available in happy-dom) ----

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  static instances: MockEventSource[] = [];
  static getLastInstance(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
  static clearInstances(): void {
    MockEventSource.instances = [];
  }

  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  private listeners: Record<string, ((ev: Event | MessageEvent) => void)[]> = {};

  constructor(public url: string) {
    MockEventSource.instances.push(this);
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockEventSource.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  addEventListener(type: string, listener: (ev: Event | MessageEvent) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (ev: Event | MessageEvent) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  // ---- Test helpers ----

  /** Simulate a transient error (readyState stays CONNECTING = auto-reconnect) */
  _simulateError() {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** Simulate a terminal error (readyState goes to CLOSED = no auto-reconnect) */
  _simulateTerminalError() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }

  /** Simulate successful reconnection (readyState goes to OPEN, fires onopen) */
  _simulateReconnect() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Simulate an SSE event of any type */
  _simulateEvent(type: string, data: string) {
    const event = new MessageEvent(type, { data });
    if (this.listeners[type]) {
      for (const listener of this.listeners[type]) {
        listener(event);
      }
    }
  }
}

vi.stubGlobal('EventSource', MockEventSource);

// ---- Y.Doc test helpers ----

function createTestDoc(markdownContent: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, markdownContent);
  return doc;
}

// We pass Y.Doc directly into DiscussionPanel as a prop rather than mocking
// @y-sweet/react, since the component will accept an optional `doc` prop for
// testability (falling back to useYDoc() in production).

// ---- Fixture helpers ----

// Get messages that have actual text content (type 0 = default message)
const textMessages = messagesFixture.filter(
  (m: { type: number; content: string }) => m.type === 0 && m.content.length > 0,
);

// The fixture is newest-first; the component should reverse to chronological (oldest-first)
const chronologicalMessages = [...textMessages].reverse();

// ---- Fetch mock helpers ----

function mockFetchSuccess() {
  return vi.fn((url: string) => {
    if (url.includes('/messages')) {
      return Promise.resolve(
        new Response(JSON.stringify(messagesFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.match(/\/api\/discord\/channels\/\d+$/)) {
      return Promise.resolve(
        new Response(JSON.stringify(channelFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('Not found', { status: 404 }));
  });
}

function mockFetchError() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ message: 'Internal Server Error' }), {
        status: 500,
      }),
    ),
  );
}

function mockFetchEmpty() {
  return vi.fn((url: string) => {
    if (url.includes('/messages')) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.match(/\/api\/discord\/channels\/\d+$/)) {
      return Promise.resolve(
        new Response(JSON.stringify(channelFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('Not found', { status: 404 }));
  });
}

function mockFetchLoading() {
  // Returns a fetch that never resolves (for testing loading state)
  return vi.fn(
    () =>
      new Promise<Response>(() => {
        // intentionally never resolves
      }),
  );
}

// ---- Test suites ----

const DISCUSSION_URL = 'https://discord.com/channels/1443369661847834688/1443369662560735264';

describe('DiscussionPanel - with discussion frontmatter', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = createTestDoc(`---\ndiscussion: ${DISCUSSION_URL}\n---\nSome document content`);
    vi.stubGlobal('fetch', mockFetchSuccess());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    MockEventSource.clearInstances();
  });

  it('renders message text from fixture data', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // The first chronological text message content should appear
    // Use getAllByText since the fixture has duplicate message content
    const firstMsg = chronologicalMessages[0];
    await waitFor(() => {
      const matches = screen.getAllByText(firstMsg.content, { exact: false });
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('renders usernames', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // lucbrinkman has global_name "Luc Brinkman" -- appears multiple times due to grouping headers
    await waitFor(() => {
      const matches = screen.getAllByText('Luc Brinkman');
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('renders bot username when global_name is null', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // "Luc's Dev App" has null global_name, should fall back to username
    // Appears multiple times since the bot posts many messages
    await waitFor(() => {
      const matches = screen.getAllByText("Luc's Dev App");
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('renders avatar images with correct src', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      // lucbrinkman has avatar hash "8268a38d449e8329c73a19a9b52a02ec"
      const avatars = screen.getAllByRole('img');
      const lucAvatar = avatars.find((img) =>
        (img as HTMLImageElement).src.includes('8268a38d449e8329c73a19a9b52a02ec'),
      );
      expect(lucAvatar).toBeDefined();
    });
  });

  it('renders default avatar for users without custom avatar', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      // "Luc's Dev App" (id: 1443370056875642980) has null avatar, should use default
      const avatars = screen.getAllByRole('img');
      const defaultAvatar = avatars.find((img) =>
        (img as HTMLImageElement).src.includes('embed/avatars/'),
      );
      expect(defaultAvatar).toBeDefined();
    });
  });

  it('renders formatted timestamps', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // Timestamps from fixture are from Jan/Feb 2026.
    // formatTimestamp will show either relative (e.g. "3d ago") or absolute (e.g. "Jan 15")
    await waitFor(() => {
      const timeElements = screen.getAllByText(/ago|just now|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
      expect(timeElements.length).toBeGreaterThan(0);
    });
  });

  it('renders channel name in header', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(`#${channelFixture.name}`)).toBeInTheDocument();
    });
  });

  it('groups consecutive messages from same author within 5 minutes', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      // The fixture has consecutive bot messages very close in time.
      // In the reversed (chronological) order, there should be grouped messages
      // where some have no visible header (avatar + username).
      // Count the data-testid="message-header" elements vs total messages.
      const headers = document.querySelectorAll('[data-testid="message-header"]');
      const items = document.querySelectorAll('[data-testid="message-item"]');
      // With grouping, headers < items (some messages are grouped)
      expect(items.length).toBeGreaterThan(0);
      expect(headers.length).toBeLessThan(items.length);
    });
  });

  it('shows loading state before messages arrive', async () => {
    vi.stubGlobal('fetch', mockFetchLoading());

    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // Should show loading indicator immediately
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});

describe('DiscussionPanel - without discussion frontmatter', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    MockEventSource.clearInstances();
  });

  it('renders nothing when no discussion field', () => {
    const doc = createTestDoc('---\ntitle: No Discussion\n---\nJust content');
    const { container } = render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when no frontmatter at all', () => {
    const doc = createTestDoc('Just plain content');
    const { container } = render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when doc is null', () => {
    const { container } = render(<DiscussionPanel doc={null} />, { wrapper: Wrapper });
    expect(container.innerHTML).toBe('');
  });
});

describe('DiscussionPanel - error states', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = createTestDoc(`---\ndiscussion: ${DISCUSSION_URL}\n---\nContent`);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    MockEventSource.clearInstances();
  });

  it('shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', mockFetchError());

    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/error|failed|could not/i)).toBeInTheDocument();
    });
  });

  it('shows retry button on error', async () => {
    vi.stubGlobal('fetch', mockFetchError());

    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
  });

  it('retries fetch when retry button clicked', async () => {
    const errorFetch = mockFetchError();
    vi.stubGlobal('fetch', errorFetch);

    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // Wait for error state and click retry in one step to avoid race with EventSource
    let callCountBefore = 0;
    await waitFor(() => {
      const retryBtn = screen.getByRole('button', { name: /retry/i });
      expect(retryBtn).toBeInTheDocument();
      callCountBefore = errorFetch.mock.calls.length;
      fireEvent.click(retryBtn);
    });

    // Should have made additional fetch calls
    await waitFor(() => {
      expect(errorFetch.mock.calls.length).toBeGreaterThan(callCountBefore);
    });
  });
});

describe('DiscussionPanel - empty channel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    MockEventSource.clearInstances();
  });

  it('shows empty state message', async () => {
    const doc = createTestDoc(`---\ndiscussion: ${DISCUSSION_URL}\n---\nContent`);
    vi.stubGlobal('fetch', mockFetchEmpty());

    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/no messages/i)).toBeInTheDocument();
    });
  });
});

describe('DiscussionPanel - connection resilience', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = createTestDoc(`---\ndiscussion: ${DISCUSSION_URL}\n---\nContent`);
    vi.stubGlobal('fetch', mockFetchSuccess());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    MockEventSource.clearInstances();
  });

  it("shows 'Live' text when connected", async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // MockEventSource fires onopen via setTimeout(0) — waitFor handles the timing
    await waitFor(() => {
      expect(screen.getByText('Live')).toBeInTheDocument();
    });
  });

  it("shows 'Reconnecting' text on transient SSE error", async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // Wait for connection to open
    await waitFor(() => {
      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    // Simulate transient error (browser will auto-reconnect)
    const instance = MockEventSource.getLastInstance();
    act(() => {
      instance._simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    });
  });

  it("shows 'Disconnected' text on terminal SSE error", async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // Wait for connection to open
    await waitFor(() => {
      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    // Simulate terminal error (browser will NOT auto-reconnect)
    const instance = MockEventSource.getLastInstance();
    act(() => {
      instance._simulateTerminalError();
    });

    await waitFor(() => {
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });
  });

  it('shows Reconnect button on terminal disconnect', async () => {
    render(<DiscussionPanel doc={doc} />, { wrapper: Wrapper });

    // Wait for connection to open
    await waitFor(() => {
      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    // Simulate terminal error
    const instance = MockEventSource.getLastInstance();
    act(() => {
      instance._simulateTerminalError();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
    });
  });
});
