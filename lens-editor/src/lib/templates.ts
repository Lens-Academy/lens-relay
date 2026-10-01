import { generateUUID } from './relay-api';
import { parse } from './criticmarkup-parser';
import { rejectChange } from './criticmarkup-actions';

export interface TemplateOption {
  /** Prefixed tree path, e.g. "/Lens Edu/Lenses/Lens Template.md". */
  path: string;
  /** File name without ".md", shown in the menu. */
  name: string;
  /** Document UUID (without the relay id). */
  docId: string;
}

// "Lens Template.md", "Lens Template -- No Article.md", "Module Template.md";
// not "Email Outreach Templates.md" or "MOC; Templates, Guides, and How-Tos.md".
const TEMPLATE_NAME = /\bTemplate\b/;

/**
 * Markdown files named like a template that sit directly in `folderPath` or
 * in one of its parent folders (up to the shared folder root), nearest first.
 */
export function findTemplates(
  metadata: Record<string, { id: string; type: string }>,
  folderPath: string,
): TemplateOption[] {
  const folders: string[] = [];
  const parts = folderPath.split('/').filter(Boolean);
  for (let depth = parts.length; depth >= 1; depth--) {
    folders.push(`/${parts.slice(0, depth).join('/')}/`);
  }

  const templates: TemplateOption[] = [];
  for (const folder of folders) {
    const here: TemplateOption[] = [];
    for (const [path, meta] of Object.entries(metadata)) {
      if (meta.type !== 'markdown' || !path.startsWith(folder) || !path.endsWith('.md')) continue;
      const rest = path.slice(folder.length);
      if (rest.includes('/')) continue;
      const name = rest.slice(0, -'.md'.length);
      if (TEMPLATE_NAME.test(name)) here.push({ path, name, docId: meta.id });
    }
    here.sort((a, b) => a.name.localeCompare(b.name));
    templates.push(...here);
  }
  return templates;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
// An id field that is empty or holds a "<...>" placeholder (LF or CRLF line ends).
const FRONTMATTER_ID = /^(id:)[ \t]*(?:<[^>\r\n]*>)?[ \t]*(?=\r?$)/gm;
const FIELD_ID = /^([ \t]*id::)[ \t]*(?:<[^>\r\n]*>)?[ \t]*(?=\r?$)/gm;

/**
 * Fill every empty or placeholder `id:` (frontmatter) and `id::` (segment
 * field) in a template with its own fresh UUID. Ids that already hold a
 * value are left alone.
 */
export function fillTemplateIds(text: string, newId: () => string = generateUUID): string {
  const frontmatter = text.match(FRONTMATTER)?.[0] ?? '';
  const head = frontmatter.replace(FRONTMATTER_ID, (_, key: string) => `${key} ${newId()}`);
  const body = text.slice(frontmatter.length).replace(FIELD_ID, (_, key: string) => `${key} ${newId()}`);
  return head + body;
}

/**
 * Drop pending CriticMarkup from a template: comments go, and suggestions are
 * rejected, so a new file gets the template as it stands, not open review notes.
 */
export function withoutPendingMarkup(text: string): string {
  const ranges = parse(text).sort((a, b) => b.from - a.from);
  return ranges.reduce((doc, range) => rejectChange(doc, range), text);
}

/** A template's text, ready to be a new file's content. */
export function prepareTemplateText(text: string, newId: () => string = generateUUID): string {
  return fillTemplateIds(withoutPendingMarkup(text), newId);
}
