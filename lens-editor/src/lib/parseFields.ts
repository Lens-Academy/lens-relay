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
