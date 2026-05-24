import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { CommentThread } from './CommentThread';
import { editMessage, parseComments } from './comment-store';

const ORIGIN = Symbol('test-origin');

function renderThread(initial: string, options: {
  currentUser?: string;
  threadId?: string;
  onClose?: () => void;
  readOnly?: boolean;
} = {}) {
  const doc = new Y.Doc();
  const ytext = doc.getText('contents');
  ytext.insert(0, initial);

  const view = render(
    <CommentThread
      ytext={ytext}
      origin={ORIGIN}
      threadId={options.threadId ?? 'c1'}
      currentUser={options.currentUser ?? 'me@x'}
      readOnly={options.readOnly}
      onClose={options.onClose ?? (() => {})}
    />
  );

  return { doc, ytext, ...view };
}

describe('CommentThread', () => {
  it('renders the parent comment body and author', () => {
    renderThread(
      '<!--lens-comment {"id":"c1","author":"luc@x","ts":"2026-05-23T00:00:00Z","body":"why?"}-->'
    );

    expect(screen.getByText('why?')).toBeInTheDocument();
    expect(screen.getByText(/luc@x/)).toBeInTheDocument();
  });

  it('renders parent and replies as articles in order', () => {
    renderThread(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"question"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"b","ts":"t1","body":"first"}-->' +
      '<!--lens-reply {"id":"r2","parent":"c1","author":"c","ts":"t2","body":"second"}-->'
    );

    expect(screen.getAllByRole('article').map(article => article.textContent)).toEqual([
      expect.stringContaining('question'),
      expect.stringContaining('first'),
      expect.stringContaining('second'),
    ]);
  });

  it('submitting a reply adds a reply marker with generated metadata', async () => {
    const { ytext } = renderThread(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"q"}-->',
      { currentUser: 'me@x' }
    );

    await userEvent.type(screen.getByRole('textbox', { name: /reply/i }), 'thanks');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    const reply = parseComments(ytext.toString())[0].replies[0];
    expect(reply).toMatchObject({
      parent: 'c1',
      author: 'me@x',
      body: 'thanks',
    });
    expect(reply.id).toEqual(expect.any(String));
    expect(reply.id.length).toBeGreaterThan(0);
    expect(new Date(reply.ts).toISOString()).toBe(reply.ts);
  });

  it('shows edit/delete only for messages authored by the current user', () => {
    renderThread(
      '<!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"mine"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"them@x","ts":"t1","body":"theirs"}-->',
      { currentUser: 'me@x' }
    );

    const ownArticle = screen.getByText('mine').closest('article');
    const otherArticle = screen.getByText('theirs').closest('article');

    expect(ownArticle).not.toBeNull();
    expect(otherArticle).not.toBeNull();
    expect(within(ownArticle!).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(ownArticle!).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(otherArticle!).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(otherArticle!).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('edits own parent and reply messages', async () => {
    const { ytext } = renderThread(
      '<!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"old parent"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"me@x","ts":"t1","body":"old reply"}-->',
      { currentUser: 'me@x' }
    );

    const parentArticle = screen.getByText('old parent').closest('article')!;
    await userEvent.click(within(parentArticle).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(parentArticle).getByRole('textbox', { name: /edit message/i }));
    await userEvent.type(within(parentArticle).getByRole('textbox', { name: /edit message/i }), 'new parent');
    await userEvent.click(within(parentArticle).getByRole('button', { name: /save/i }));

    const replyArticle = screen.getByText('old reply').closest('article')!;
    await userEvent.click(within(replyArticle).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(replyArticle).getByRole('textbox', { name: /edit message/i }));
    await userEvent.type(within(replyArticle).getByRole('textbox', { name: /edit message/i }), 'new reply');
    await userEvent.click(within(replyArticle).getByRole('button', { name: /save/i }));

    const cluster = parseComments(ytext.toString())[0];
    expect(cluster.comment.body).toBe('new parent');
    expect(cluster.replies[0].body).toBe('new reply');
  });

  it('deleting an own reply removes only that reply', async () => {
    const { ytext } = renderThread(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"parent"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"me@x","ts":"t1","body":"mine"}-->' +
      '<!--lens-reply {"id":"r2","parent":"c1","author":"a","ts":"t2","body":"theirs"}-->',
      { currentUser: 'me@x' }
    );

    const replyArticle = screen.getByText('mine').closest('article')!;
    await userEvent.click(within(replyArticle).getByRole('button', { name: 'Delete' }));

    expect(parseComments(ytext.toString())[0].replies.map(reply => reply.id)).toEqual(['r2']);
  });

  it('deleting an own parent removes the thread and closes the popover', async () => {
    const onClose = vi.fn();
    const { ytext } = renderThread(
      '<!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"mine"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"me@x","ts":"t1","body":"x"}-->',
      { currentUser: 'me@x', onClose }
    );

    const parentArticle = screen.getByText('mine').closest('article')!;
    await userEvent.click(within(parentArticle).getByRole('button', { name: 'Delete' }));

    expect(parseComments(ytext.toString())).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('read-only mode shows thread content but hides mutation controls', () => {
    renderThread(
      '<!--lens-comment {"id":"c1","author":"me@x","ts":"t","body":"mine"}-->' +
      '<!--lens-reply {"id":"r1","parent":"c1","author":"me@x","ts":"t1","body":"reply"}-->',
      { currentUser: 'me@x', readOnly: true }
    );

    expect(screen.getByText('mine')).toBeInTheDocument();
    expect(screen.getByText('reply')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /reply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn();
    renderThread(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->',
      { onClose }
    );

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking Close calls onClose in a live thread', async () => {
    const onClose = vi.fn();
    renderThread(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"x"}-->',
      { onClose }
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refreshes displayed messages after external Y.Text edits', () => {
    const { ytext } = renderThread(
      '<!--lens-comment {"id":"c1","author":"a","ts":"t","body":"old body"}-->'
    );

    act(() => {
      editMessage(ytext, ORIGIN, { id: 'c1', newBody: 'new body' });
    });

    expect(screen.getByText('new body')).toBeInTheDocument();
    expect(screen.queryByText('old body')).not.toBeInTheDocument();
  });
});
