/**
 * Parse a relay markdown document into logical sections.
 *
 * Sections are delimited by `#### <Type>` headers (Video, Text, Chat)
 * and frontmatter (---...---). Each section has a character range [from, to)
 * in the original text.
 */

export interface Section {
  /** Section type: 'frontmatter', 'video', 'text', 'chat', 'heading', or 'unknown' */
  type: string;
  /** Human-readable label */
  label: string;
  /** Start character offset (inclusive) */
  from: number;
  /** End character offset (exclusive) */
  to: number;
  /** The raw text content of this section */
  content: string;
}

/**
 * Parse document text into sections.
 * Recognizes:
 * - YAML frontmatter (--- ... ---)
 * - #### Video / #### Text / #### Chat sections
 * - ## Lens: / ## Test: / ## Learning Outcome: sections
 * - # Lens: / # Module: / # Learning Outcome: / # Meeting: top-level sections
 */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  if (!text) return sections;

  let pos = 0;

  // 1. Frontmatter
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const endMarker = text.indexOf('\n---', 3);
    if (endMarker !== -1) {
      // Include the closing --- and its newline
      const fmEnd = text.indexOf('\n', endMarker + 4);
      const to = fmEnd !== -1 ? fmEnd + 1 : text.length;
      sections.push({
        type: 'frontmatter',
        label: 'Frontmatter',
        from: 0,
        to,
        content: text.slice(0, to),
      });
      pos = to;
    }
  }

  // 2. Scan for section headers
  // We look for lines starting with # at various levels
  const headerPattern = /^(#{1,4})\s+(.+)$/gm;
  const headers: { level: number; title: string; from: number; lineEnd: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(text)) !== null) {
    if (match.index < pos) continue; // skip headers inside frontmatter
    headers.push({
      level: match[1].length,
      title: match[2].trim(),
      from: match.index,
      lineEnd: match.index + match[0].length,
    });
  }

  // If no headers found after frontmatter, the rest is one section
  if (headers.length === 0) {
    if (pos < text.length) {
      sections.push({
        type: 'body',
        label: 'Content',
        from: pos,
        to: text.length,
        content: text.slice(pos, text.length),
      });
    }
    return sections;
  }

  // Gap between frontmatter (or doc start) and first header —
  // absorb into the previous section or create a body section.
  // Must not leave gaps: every character must belong to a section.
  if (pos < headers[0].from) {
    if (sections.length > 0) {
      // Extend the frontmatter section to cover the gap
      sections[sections.length - 1].to = headers[0].from;
      sections[sections.length - 1].content = text.slice(
        sections[sections.length - 1].from,
        headers[0].from,
      );
    } else {
      // No frontmatter — create a body section for the gap
      sections.push({
        type: 'body',
        label: 'Content',
        from: pos,
        to: headers[0].from,
        content: text.slice(pos, headers[0].from),
      });
    }
  }

  // 3. Create sections from headers
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const nextFrom = i + 1 < headers.length ? headers[i + 1].from : text.length;

    const sectionContent = text.slice(header.from, nextFrom);
    const type = classifyHeader(header.title, header.level);
    const label = cleanLabel(header.title, header.level);

    sections.push({
      type,
      label,
      from: header.from,
      to: nextFrom,
      content: sectionContent,
    });
  }

  return sections;
}

function classifyHeader(title: string, level: number): string {
  const lower = title.toLowerCase().replace(/:$/, '').trim();

  if (level === 4) {
    if (lower === 'video') return 'video';
    if (lower === 'text') return 'text';
    if (lower === 'chat') return 'chat';
  }
  if (lower.startsWith('lens')) return 'lens-ref';
  if (lower.startsWith('test')) return 'test-ref';
  if (lower.startsWith('learning outcome')) return 'lo-ref';
  if (lower.startsWith('module')) return 'module-ref';
  if (lower.startsWith('meeting')) return 'meeting-ref';

  return 'heading';
}

function cleanLabel(title: string, level: number): string {
  const lower = title.toLowerCase().replace(/:$/, '').trim();

  if (level === 4) {
    if (lower === 'video') return 'Video';
    if (lower === 'text') return 'Text';
    if (lower === 'chat') return 'Chat Instructions';
  }

  // For reference sections like "# Lens:" or "## Test:", show the full title
  return title.replace(/:$/, '').trim();
}
