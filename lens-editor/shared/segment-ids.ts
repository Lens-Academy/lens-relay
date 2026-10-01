/**
 * Response segments that must carry an `id::` (the stable key for a learner's
 * answers or chat session): `#### Question`, `#### Question: <Subtype>`,
 * `#### Roleplay[: title]` and `#### Interview[: title]`. The platform rejects
 * them without one (lens-platform content_processor: response-segments.ts
 * `parseResponseSegment`, lens.ts `parseSessionId`); its header pattern is
 * `^#{n,6}\s+<type>(?::\s*<title>)?\s*$`, case-insensitive.
 *
 * In a survey a bare `#### Question` is the `key::`-based survey segment and
 * has no id, so it is not an id-bearing header there.
 */
export const RESPONSE_SEGMENT_HEADER = /^#{2,6}\s+(question|roleplay|interview)\s*(?::\s*(.*?))?\s*$/i;

/** A field line assigning the segment id. */
const ID_LINE = /^\s*id::/;
/** Any heading line ends a segment's field block. */
const HEADING_LINE = /^#/;

/** True for paths under a `surveys/` folder ("/Lens Edu/surveys/x.md"). */
export function isSurveyPath(path: string): boolean {
  return path.split('/').slice(0, -1).includes('surveys');
}

/** Does this header line start a segment that needs an `id::`? */
export function needsSegmentId(headerLine: string, inSurvey: boolean): boolean {
  const match = RESPONSE_SEGMENT_HEADER.exec(headerLine);
  if (!match) return false;
  const bareQuestion = match[1].toLowerCase() === 'question' && !match[2];
  return !(inSurvey && bareQuestion);
}

/** Does the field block after a header (up to the next heading) hold an `id::` line? */
export function blockHasId(linesAfterHeader: Iterable<string>): boolean {
  for (const line of linesAfterHeader) {
    if (HEADING_LINE.test(line)) return false;
    if (ID_LINE.test(line)) return true;
  }
  return false;
}
