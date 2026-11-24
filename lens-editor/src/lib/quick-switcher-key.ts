/**
 * Whether a key press should open the quick switcher: Ctrl/Cmd+K or Ctrl/Cmd+O.
 * Not with Shift or Alt (Cmd+Shift+K deletes a line, and Mac reports e.key 'k'
 * for it), and not when the editor already handled the key.
 */
export function isQuickSwitcherKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.shiftKey || e.altKey) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  const key = e.key.toLowerCase();
  return key === 'k' || key === 'o';
}
