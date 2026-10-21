// `backticked` names in a check's words: jev reads them as keys of the state it is shown.
const STATE_KEYS = ['paragraph'];

/** Plain runs and `backticked` names, marking names that are not state keys. */
export function keyRuns(text: string) {
  return text.split(/(`[^`\n]*`)/).map((t) => {
    const m = t.match(/^`([^`]*)`$/);
    return { t, key: !!m, known: !!m && STATE_KEYS.includes(m[1]) };
  });
}

/** What the question must say about jev's input, or nothing if it already does. */
export function keyHint(text: string): string | undefined {
  const keys = keyRuns(text).filter((r) => r.key);
  if (!keys.some((r) => r.known)) return `jev only knows the text as \`${STATE_KEYS[0]}\`; name it in backticks`;
  if (keys.some((r) => !r.known)) return `jev's input has only ${STATE_KEYS.map((k) => '`' + k + '`').join(', ')}`;
}

