/**
 * What Lens reads as its own syntax, and how the Iliad sync keeps a page's
 * text from being read that way.
 *
 * Lens takes two things out of a lens file before it reads the markdown:
 * `%% ... %%` comments and CriticMarkup (`{++ ++}`, `{-- --}`, `{~~ ~~}`,
 * `{== ==}`, `{>> <<}`). It then reads `key::` lines and `#` lines as the
 * file's structure, and in the text `:::name` fences and `:name` directives.
 */

/** Running text: `%%` would open a comment, and `10:30` holds the directive `:30`, which Lens would drop. */
export function escapeText(text: string): string {
  return text
    .split(/(https?:\/\/[^\s<>]*)/)
    .map((part, i) => (i % 2 ? part : part.replace(/%%/g, "\\%\\%").replace(/(?<!:):(?=[^\s\p{P}\p{S}])/gu, "\\:")))
    .join("");
}

/**
 * A line of text Lens would read as structure: a `key::` field of the
 * segment, a `:::` fence, or the `\#` that escapes a heading, which Lens
 * turns back into `#`.
 */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^([\w-]+)(::)/, "$1\\$2")
    .replace(/^( {0,3})(:{2,})/, "$1\\$2")
    .replace(/^\\#/, "&#35;")
    .replace(/^!#/, "\\!#");
}

/**
 * A formula: `\text{--}` would lose its braces to CriticMarkup. `\relax` and
 * a space after `%` change nothing TeX draws.
 */
export function guardMath(tex: string): string {
  return tex.replace(/\{(?=\+\+|--|~~|==|>>)/g, "{\\relax ").replace(/%(?=%)/g, "% ");
}

/**
 * A line of a displayed formula. Lens takes the backslash off a line that
 * starts with `\#`; an empty group in front keeps it (`\#\{t : ...\}`).
 */
export function guardMathLine(line: string): string {
  return line.replace(/^(?=[\\!]#)/, "{}");
}

/** The first thing in `code` that Lens would act on, or null. Code cannot be escaped, only reported. */
export function lensMarkupIn(code: string): string | null {
  return /%%|\{(?:\+\+|--|~~|==|>>)|^[\\!]#/m.exec(code)?.[0] ?? null;
}
