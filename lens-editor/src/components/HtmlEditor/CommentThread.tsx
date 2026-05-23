import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type * as Y from 'yjs';
import {
  addReply,
  deleteMessage,
  editMessage,
  parseComments,
  type CommentMarker,
  type ReplyMarker,
} from './comment-store';

interface CommentThreadProps {
  ytext: Y.Text;
  origin: unknown;
  threadId: string;
  currentUser: string;
  onClose: () => void;
}

type MessageMarker = CommentMarker | ReplyMarker;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function useCommentSnapshot(ytext: Y.Text, threadId: string) {
  const readSnapshot = useCallback(
    () => parseComments(ytext.toString()).find(cluster => cluster.comment.id === threadId),
    [threadId, ytext]
  );
  const [snapshot, setSnapshot] = useState(readSnapshot);

  useEffect(() => {
    const update = () => setSnapshot(readSnapshot());
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [readSnapshot, ytext]);

  return snapshot;
}

function Message({
  msg,
  currentUser,
  onEdit,
  onDelete,
}: {
  msg: MessageMarker;
  currentUser: string;
  onEdit: (body: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const isOwn = msg.author === currentUser;

  const save = () => {
    onEdit(draft);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(msg.body);
    setEditing(false);
  };

  return (
    <article className="border-b border-gray-100 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="font-medium text-gray-700">{msg.author}</span>
        <span>{msg.ts}</span>
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            aria-label="Edit message"
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 outline-none focus:border-gray-400"
            value={draft}
            onChange={event => setDraft(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-gray-900 px-2 py-1 text-xs text-white hover:bg-gray-800"
              onClick={save}
            >
              Save
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{msg.body}</div>
      )}

      {isOwn && !editing && (
        <div className="mt-2 flex gap-3">
          <button
            type="button"
            aria-label="Edit"
            className="text-xs text-gray-500 hover:text-gray-800"
            onClick={() => {
              setDraft(msg.body);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            aria-label="Delete"
            className="text-xs text-gray-500 hover:text-red-600"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      )}
    </article>
  );
}

export function CommentThread({ ytext, origin, threadId, currentUser, onClose }: CommentThreadProps) {
  const snapshot = useCommentSnapshot(ytext, threadId);
  const [reply, setReply] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submitReply = useCallback((event?: FormEvent) => {
    event?.preventDefault();
    const body = reply.trim();
    if (!body) return;

    addReply(ytext, origin, {
      id: newId(),
      parent: threadId,
      author: currentUser,
      ts: new Date().toISOString(),
      body,
    });
    setReply('');
  }, [currentUser, origin, reply, threadId, ytext]);

  if (!snapshot) {
    return (
      <div className="w-80 rounded border border-gray-200 bg-white p-3 shadow-lg">
        <div className="text-sm text-gray-500">Comment no longer exists.</div>
        <button
          type="button"
          className="mt-2 text-xs text-gray-600 hover:text-gray-900"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="w-80 overflow-hidden rounded border border-gray-200 bg-white shadow-lg">
      <div className="flex justify-end border-b border-gray-100 px-3 py-2">
        <button
          type="button"
          aria-label="Close"
          className="text-xs text-gray-500 hover:text-gray-900"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <Message
        msg={snapshot.comment}
        currentUser={currentUser}
        onEdit={body => editMessage(ytext, origin, { id: snapshot.comment.id, newBody: body })}
        onDelete={() => {
          deleteMessage(ytext, origin, snapshot.comment.id);
          onClose();
        }}
      />

      {snapshot.replies.map(replyMarker => (
        <Message
          key={replyMarker.id}
          msg={replyMarker}
          currentUser={currentUser}
          onEdit={body => editMessage(ytext, origin, { id: replyMarker.id, newBody: body })}
          onDelete={() => deleteMessage(ytext, origin, replyMarker.id)}
        />
      ))}

      <form className="border-t border-gray-100 p-3" onSubmit={submitReply}>
        <textarea
          aria-label="Reply"
          placeholder="Reply..."
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-400"
          value={reply}
          onChange={event => setReply(event.target.value)}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            className="rounded bg-gray-900 px-3 py-1 text-xs text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            disabled={reply.trim() === ''}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
