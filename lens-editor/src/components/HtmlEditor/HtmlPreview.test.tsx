// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import * as Y from 'yjs';
import { HtmlPreview } from './HtmlPreview';

describe('HtmlPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a sandboxed iframe with ONLY the allow-scripts token (no allow-same-origin)', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '<h1>Hello</h1>');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('updates srcdoc after a Y.Text mutation, debounced by 300ms', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');

    const { container } = render(<HtmlPreview ytext={ytext} />);
    const iframe = () => container.querySelector('iframe')!;

    await act(async () => {
      ytext.insert(0, '<p>first</p>');
    });

    await act(async () => { vi.advanceTimersByTime(100); });
    expect(iframe().getAttribute('srcdoc') ?? '').toBe('');

    await act(async () => { vi.advanceTimersByTime(250); });
    expect(iframe().getAttribute('srcdoc')).toBe('<p>first</p>');

    await act(async () => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(iframe().getAttribute('srcdoc')).toBe('<p>first</p>');
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(iframe().getAttribute('srcdoc')).toBe('<p>second</p>');
  });
});
