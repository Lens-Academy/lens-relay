/**
 * Extract field:: value pairs from section content.
 *
 * Supports:
 * - Single-line: `key:: value`
 * - Quoted: `key:: "value"` (strips quotes)
 * - Multi-line: value continues on subsequent lines until next `key::` line
 * - Empty: `key:: ""` -> empty string
 */
export function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split('\n');

  let currentKey: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const fieldMatch = line.match(/^(\w[\w-]*)::(?:\s(.*))?$/);

    if (fieldMatch) {
      if (currentKey !== null) {
        fields.set(currentKey, finishValue(currentLines));
      }

      currentKey = fieldMatch[1];
      const rest = (fieldMatch[2] ?? '').trim();

      if (rest) {
        currentLines = [stripQuotes(rest)];
      } else {
        currentLines = [];
      }
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }

  if (currentKey !== null) {
    fields.set(currentKey, finishValue(currentLines));
  }

  return fields;
}

/**
 * Extract key: value pairs from YAML frontmatter (single colon).
 * Simple line-by-line extraction -- not a full YAML parser.
 * Handles only top-level scalar fields (not arrays/objects).
 */
export function parseFrontmatterFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split('\n');
  let inFrontmatter = false;

  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      break;
    }
    if (!inFrontmatter) continue;

    const match = line.match(/^(\w[\w-]*):\s+(.+)$/);
    if (match) {
      fields.set(match[1], stripQuotes(match[2].trim()));
    }
  }

  return fields;
}

/**
 * Read a single field from the frontmatter section of a parsed section list.
 * Returns undefined if there is no frontmatter section or the field is absent.
 */
export function getFrontmatterField(
  sections: Array<{ type: string; content: string }>,
  fieldName: string,
): string | undefined {
  const fm = sections.find(s => s.type === 'frontmatter');
  return fm ? parseFrontmatterFields(fm.content).get(fieldName) : undefined;
}

/**
 * Compute the absolute Y.Text offset range [from, to) of a named field's
 * value within a section. Returns the section's full range if the field
 * isn't present.
 */
export function getFieldValueRange(
  sectionContent: string,
  sectionFrom: number,
  fieldName: string,
): [number, number] {
  const pattern = new RegExp(`^${fieldName}::(?:\\s(.*))?$`, 'm');
  const match = pattern.exec(sectionContent);
  if (!match) return [sectionFrom, sectionFrom + sectionContent.length];

  const fieldLineEnd = match.index + match[0].length;
  const inlineValue = match[1]?.trim();
  let valueStart: number;
  if (inlineValue) {
    valueStart = match.index + match[0].indexOf(inlineValue);
  } else {
    valueStart = fieldLineEnd + 1;
  }

  const rest = sectionContent.slice(valueStart);
  const nextField = rest.match(/^\w[\w-]*::(?:\s|$)/m);
  let valueEnd: number;
  if (nextField) {
    let end = valueStart + nextField.index!;
    while (end > valueStart && sectionContent[end - 1] === '\n') end--;
    valueEnd = end;
  } else {
    let end = sectionContent.length;
    while (end > valueStart && sectionContent[end - 1] === '\n') end--;
    valueEnd = end;
  }

  return [sectionFrom + valueStart, sectionFrom + valueEnd];
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function finishValue(lines: string[]): string {
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  // Trim leading empty lines
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  return lines.join('\n');
}
