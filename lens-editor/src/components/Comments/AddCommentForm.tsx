import { useState, useRef, useEffect, useLayoutEffect } from 'react';

interface AddCommentFormProps {
  onSubmit: (content: string) => void;
  /** Receives the unsent text, so a caller can keep the draft. */
  onCancel: (unsent: string) => void;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  /** Pre-populates the textarea (used by the Edit flow). */
  initialValue?: string;
  /** "bar": Notion's reply bar, the field and its send arrow on one line, no Cancel */
  variant?: 'form' | 'bar';
}

/**
 * Notion's comment box: a borderless field that grows with its text, with
 * Cancel and a round blue send arrow (named by `submitLabel`). Enter sends,
 * Shift+Enter starts a new line, Escape cancels.
 */
export function AddCommentForm({
  onSubmit,
  onCancel,
  placeholder = 'Add a comment…',
  submitLabel = 'Add',
  autoFocus = true,
  initialValue = '',
  variant = 'form',
}: AddCommentFormProps) {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [autoFocus]);

  // Grow with the text
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    onSubmit(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onCancel(text);
    }
  };

  const canSend = text.trim() !== '';

  const sendButton = (
    <button
      type="button"
      onClick={handleSubmit}
      className="lens-comment-send"
      data-ready={canSend ? '' : undefined}
      aria-label={submitLabel}
      title={submitLabel}
    >
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="currentColor" />
        <path d="M12 17V7.5M7.75 11.5 12 7.25l4.25 4.25" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only">{submitLabel}</span>
    </button>
  );

  if (variant === 'bar') {
    return (
      <div className="add-comment-form lens-comment-replybar">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="lens-comment-input"
          rows={1}
        />
        {sendButton}
      </div>
    );
  }

  return (
    <div className="add-comment-form lens-comment-form">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="lens-comment-input"
        rows={1}
      />
      <div className="lens-comment-form-buttons">
        <button
          type="button"
          onClick={() => onCancel(text)}
          className="lens-comment-cancel"
        >
          Cancel
        </button>
        {sendButton}
      </div>
    </div>
  );
}
