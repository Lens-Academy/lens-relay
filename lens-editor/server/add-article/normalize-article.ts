export interface NormalizationSample {
  before: string;
  after: string;
}

export interface NormalizationChange {
  code: string;
  count: number;
  samples: NormalizationSample[];
}

const MAX_SAMPLES_PER_CHANGE = 5;
const MAX_SAMPLE_CHARS = 512;

function boundedSample(value: string): string {
  return value.length <= MAX_SAMPLE_CHARS
    ? value
    : `${value.slice(0, MAX_SAMPLE_CHARS - 1)}…`;
}

interface Segment {
  text: string;
  eligible: boolean;
}

function closingFenceEnd(source: string, start: number, marker: string): number {
  const openingEnd = source.indexOf("\n", start);
  if (openingEnd < 0) return source.length;
  const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[^\\r\\n]*(?:\\r?\\n|$)`, "gm");
  close.lastIndex = openingEnd + 1;
  const match = close.exec(source);
  return match ? match.index + match[0].length : source.length;
}

/** Split Markdown into ranges where conservative textual repairs are safe.
 * Fenced/inline code, paired Obsidian comments, CriticMarkup, and math are
 * opaque. Delimiter matching is intentionally conservative: an unclosed
 * construct protects the rest of the source instead of risking a rewrite. */
function sourceSegments(source: string): Segment[] {
  const segments: Segment[] = [];
  const push = (text: string, eligible: boolean) => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous?.eligible === eligible) previous.text += text;
    else segments.push({ text, eligible });
  };
  let plainStart = 0;
  let index = 0;
  const protect = (end: number) => {
    push(source.slice(plainStart, index), true);
    push(source.slice(index, end), false);
    index = end;
    plainStart = end;
  };

  while (index < source.length) {
    const lineStart = index === 0 || source[index - 1] === "\n";
    if (lineStart) {
      const fence = source.slice(index).match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/);
      if (fence) {
        protect(closingFenceEnd(source, index, fence[1]));
        continue;
      }
    }

    if (source.startsWith("%%", index)) {
      const close = source.indexOf("%%", index + 2);
      protect(close < 0 ? source.length : close + 2);
      continue;
    }

    const critic = ([
      ["{++", "++}"],
      ["{--", "--}"],
      ["{==", "==}"],
      ["{>>", "<<}"],
      ["{~~", "~~}"],
    ] as const).find(([open]) => source.startsWith(open, index));
    if (critic) {
      const close = source.indexOf(critic[1], index + critic[0].length);
      protect(close < 0 ? source.length : close + critic[1].length);
      continue;
    }

    if (source[index] === "`") {
      const run = source.slice(index).match(/^`+/)![0];
      const close = source.indexOf(run, index + run.length);
      protect(close < 0 ? source.length : close + run.length);
      continue;
    }

    const escapedMath = source.startsWith("\\(", index)
      ? "\\)"
      : source.startsWith("\\[", index)
        ? "\\]"
        : undefined;
    if (escapedMath) {
      const close = source.indexOf(escapedMath, index + 2);
      protect(close < 0 ? source.length : close + 2);
      continue;
    }

    if (source.startsWith("$$", index)) {
      const close = source.indexOf("$$", index + 2);
      protect(close < 0 ? source.length : close + 2);
      continue;
    }
    if (source[index] === "$" && source[index - 1] !== "\\") {
      let close = index + 1;
      while ((close = source.indexOf("$", close)) >= 0 && source[close - 1] === "\\") close += 1;
      if (close >= 0) {
        protect(close + 1);
        continue;
      }
    }
    index += 1;
  }
  push(source.slice(plainStart), true);
  return segments;
}

/** Idempotent, syntax-aware, semantics-preserving repairs only. */
export function normalizeArticleBody(body: string, sourceUrl: string): {
  body: string;
  changes: NormalizationChange[];
} {
  const changes = new Map<string, NormalizationChange>();
  const record = (code: string, before: string, after: string) => {
    const change = changes.get(code) ?? { code, count: 0, samples: [] };
    change.count += 1;
    if (change.samples.length < MAX_SAMPLES_PER_CHANGE) {
      change.samples.push({ before: boundedSample(before), after: boundedSample(after) });
    }
    changes.set(code, change);
  };

  const transformed = sourceSegments(body).map((segment) => {
    if (!segment.eligible) {
      // Empty escaped inline math is the one math construct known to be pure
      // conversion residue. It is handled here, after code/comments won.
      if (/^\\\(\s*\\\)$/.test(segment.text)) {
        record("normalize.empty-inline-math", segment.text, "");
        return "";
      }
      return segment.text;
    }
    let out = segment.text;
    out = out.replace(
      /(!?\[[^\]\r\n]*\]\()\/(?!\/)([^)\s]+)(\))/g,
      (whole, open: string, destination: string, close: string) => {
        try {
          const replacement = `${open}${new URL(`/${destination}`, sourceUrl).href}${close}`;
          record("normalize.root-relative-destination", whole, replacement);
          return replacement;
        } catch {
          return whole;
        }
      },
    );
    out = out.replace(/^Posted in:[ \t]*(?:,[ \t]*)*(?=\r?$)/gm, (whole) => {
      record("normalize.empty-posted-in", whole, "");
      return "";
    });
    return out;
  });

  return { body: transformed.join(""), changes: [...changes.values()] };
}
