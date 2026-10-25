import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOJI_CATEGORIES } from './emojis';

/** Whether the text contains an emoji (so typed or pasted text can be used as one). */
const HAS_EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

interface EmojiPickerProps {
  /** Called with the chosen emoji. */
  onPick: (emoji: string) => void;
  /** Shows "Remove" when the page already has an icon. */
  onRemove?: () => void;
  onClose: () => void;
}

/**
 * Notion-style emoji picker for page icons: search, emojis by category, and
 * any emoji pasted into the search box. Closes on Escape or a click outside.
 */
export function EmojiPicker({ onPick, onRemove, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const categories = useMemo(
    () =>
      q
        ? EMOJI_CATEGORIES.map((c) => ({ ...c, emojis: c.emojis.filter(([, words]) => words.includes(q)) })).filter(
            (c) => c.emojis.length > 0,
          )
        : EMOJI_CATEGORIES,
    [q],
  );
  const typed = HAS_EMOJI.test(query) ? query.trim() : null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Choose an icon"
      className="lens-popover w-[352px] max-w-[calc(100vw-24px)] overflow-hidden"
    >
      <div className="flex items-center justify-between px-2 pt-2">
        <span className="px-2 py-1 text-[14px] font-medium">Emoji</span>
        {onRemove && (
          <button type="button" className="lens-menu-button px-2 py-1 text-[14px]" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="px-3 pt-1 pb-2">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const first = typed ?? categories[0]?.emojis[0]?.[0];
              if (first) onPick(first);
            }
          }}
          placeholder="Filter… or paste any emoji"
          aria-label="Filter emojis"
          className="lens-input w-full"
        />
      </div>
      <div className="max-h-[280px] overflow-y-auto px-2 pb-2">
        {typed && (
          <button type="button" className="lens-menu-button mb-1 flex w-full items-center gap-2 px-2 py-1 text-[14px]" onClick={() => onPick(typed)}>
            <span className="text-[20px] leading-none">{typed}</span> Use this emoji
          </button>
        )}
        {categories.map((category) => (
          <div key={category.name}>
            <div className="lens-menu-label px-2 pt-2 pb-1">{category.name}</div>
            <div className="grid grid-cols-[repeat(auto-fill,32px)] gap-0.5 px-1">
              {category.emojis.map(([emoji, words]) => (
                <button
                  key={emoji}
                  type="button"
                  title={words.split(' ')[0]}
                  aria-label={words.split(' ')[0]}
                  className="lens-emoji-button"
                  onClick={() => onPick(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
        {categories.length === 0 && !typed && (
          <div className="lens-menu-label px-3 py-4">No match. Paste any emoji to use it.</div>
        )}
      </div>
    </div>
  );
}
