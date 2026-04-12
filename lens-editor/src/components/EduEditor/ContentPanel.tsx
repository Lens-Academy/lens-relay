import { useEffect, useState, useRef } from 'react';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';
import { getSubtreeRange } from './getSubtreeRange';
import * as Y from 'yjs';
import {
  TextRenderer,
  ChatRenderer,
  ArticleRenderer,
  VideoRenderer,
  QuestionRenderer,
  HeadingRenderer,
} from './ContentPanel/renderers';

export type ContentScope =
  | { kind: 'full-doc'; docId: string; docName: string; docPath: string }
  | { kind: 'subtree'; docId: string; docName: string; docPath: string; rootSectionIndex: number; breadcrumb: string };

interface ContentPanelProps {
  scope: ContentScope | null;
}

/**
 * Find the absolute Y.Text range of a field's value within a section.
 * Returns [from, to) offsets into the full Y.Text.
 * If the field isn't found, falls back to the whole section range.
 */
function getFieldValueRange(
  sectionContent: string,
  sectionFrom: number,
  fieldName: string,
): [number, number] {
  // Find the field line: `fieldName::` optionally followed by value on same line
  const pattern = new RegExp(`^${fieldName}::(?:\\s(.*))?$`, 'm');
  const match = pattern.exec(sectionContent);
  if (!match) return [sectionFrom, sectionFrom + sectionContent.length];

  const fieldLineEnd = match.index + match[0].length;

  // Value starts after the field line (or on the same line if inline)
  const inlineValue = match[1]?.trim();
  let valueStart: number;
  if (inlineValue) {
    // Inline value: `content:: the actual text`
    valueStart = match.index + match[0].indexOf(inlineValue);
  } else {
    // Multi-line: value starts on the next line
    valueStart = fieldLineEnd + 1; // skip the \n
  }

  // Value ends at the next field line or end of section content
  const rest = sectionContent.slice(valueStart);
  const nextField = rest.match(/^\w[\w-]*::(?:\s|$)/m);
  let valueEnd: number;
  if (nextField) {
    // Trim trailing newlines before the next field
    let end = valueStart + nextField.index!;
    while (end > valueStart && sectionContent[end - 1] === '\n') end--;
    valueEnd = end;
  } else {
    // Trim trailing newlines at section end
    let end = sectionContent.length;
    while (end > valueStart && sectionContent[end - 1] === '\n') end--;
    valueEnd = end;
  }

  return [sectionFrom + valueStart, sectionFrom + valueEnd];
}

/**
 * Find the absolute Y.Text range of a YAML frontmatter field's value.
 * Handles both `key: value` and `key: "quoted value"` on a single line.
 * For multi-line quoted values, captures until the closing quote.
 */
function getFrontmatterFieldRange(
  sectionContent: string,
  sectionFrom: number,
  fieldName: string,
): [number, number] | null {
  const pattern = new RegExp(`^${fieldName}:\\s*(.*)$`, 'm');
  const match = pattern.exec(sectionContent);
  if (!match) return null;

  let valueStr = match[1];
  let valueStart = match.index + match[0].length - valueStr.length;

  // Strip surrounding quotes
  if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
    valueStart += 1;
    valueStr = valueStr.slice(1, -1);
  }

  return [sectionFrom + valueStart, sectionFrom + valueStart + valueStr.length];
}

/** Map section type to the primary prose field name */
function proseFieldForType(type: string): string | null {
  if (type === 'text') return 'content';
  if (type === 'chat') return 'instructions';
  if (type === 'question') return 'content';
  return null;
}

export function ContentPanel({ scope }: ContentPanelProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [sections, setSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Map<string, string>>(new Map());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingFmField, setEditingFmField] = useState<string | null>(null); // frontmatter field name being edited
  const ytextRef = useRef<Y.Text | null>(null);

  // Compute the editing range
  const editRange = (() => {
    if (editingIndex === null && !editingFmField) return { from: 0, to: 0 };

    const currentSections = parseSections(ytextRef.current?.toString() ?? '');

    // Frontmatter field editing
    if (editingFmField) {
      const fmSection = currentSections.find(s => s.type === 'frontmatter');
      if (!fmSection) return { from: 0, to: 0 };
      const range = getFrontmatterFieldRange(fmSection.content, fmSection.from, editingFmField);
      if (!range) return { from: 0, to: 0 };
      return { from: range[0], to: range[1] };
    }

    // Section editing
    const section = currentSections[editingIndex!];
    if (!section) return { from: 0, to: 0 };
    const proseField = proseFieldForType(section.type);
    if (proseField) {
      const [from, to] = getFieldValueRange(section.content, section.from, proseField);
      return { from, to };
    }
    return { from: section.from, to: section.to };
  })();

  const isEditing = editingIndex !== null || editingFmField !== null;

  function startEditingSection(index: number) {
    setEditingFmField(null);
    setEditingIndex(index);
  }

  const editKey = editingFmField ?? (editingIndex !== null ? `section-${editingIndex}` : null);

  const { mountRef } = useSectionEditor({
    ytext: ytextRef.current,
    sectionFrom: editRange.from,
    sectionTo: editRange.to,
    active: isEditing,
    editKey,
  });

  const docId = scope?.docId ?? null;

  // Connect to doc when scope changes
  useEffect(() => {
    if (!docId) return;

    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(docId!);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      ytextRef.current = ytext;

      const update = () => {
        const text = ytext.toString();
        const parsed = parseSections(text);
        setSections(parsed);

        const fmSection = parsed.find(s => s.type === 'frontmatter');
        if (fmSection) {
          setFrontmatter(parseFrontmatterFields(fmSection.content));
        }
      };

      setSynced(true);
      update();
      ytext.observe(update);

      return () => {
        ytext.unobserve(update);
      };
    }

    setSynced(false);
    setSections([]);
    setEditingIndex(null);
    setEditingFmField(null);
    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [docId, getOrConnect]);

  // Null scope: show placeholder
  if (!scope) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-24">
        <div className="text-2xl font-semibold text-gray-400">Pick a lens</div>
        <div className="text-sm text-gray-400">Select a lens from the list on the left to get started.</div>
      </div>
    );
  }

  if (!synced) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        Loading lens...
      </div>
    );
  }

  // Derive lensPath and lensUuid for article/video source resolution
  const lensUuid = scope.docId.slice(RELAY_ID.length + 1);
  const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';

  const tldr = frontmatter.get('tldr');

  let visibleFrom = 0;
  let visibleTo = sections.length;
  if (scope.kind === 'subtree' && sections.length > scope.rootSectionIndex) {
    const [rangeFrom, rangeTo] = getSubtreeRange(sections, scope.rootSectionIndex);
    visibleFrom = rangeFrom + 1; // skip the root header itself — it's in the toolbar
    visibleTo = rangeTo;
  }

  return (
    <div>
      <div className="mb-6 text-[11px] text-gray-400">
        {scope.docName}.md
        {scope.kind === 'subtree' && <span> &middot; {scope.breadcrumb}</span>}
      </div>

      {editingFmField === 'tldr' ? (
        <div className="mb-4 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
            <span className="font-medium text-sm text-blue-700">User-facing TL;DR</span>
            <button onClick={() => setEditingFmField(null)}
              className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
              Done
            </button>
          </div>
          <div ref={mountRef} style={{ minHeight: '40px' }} />
        </div>
      ) : tldr ? (
        <div className="mb-4 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
          onClick={() => { setEditingIndex(null); setEditingFmField('tldr'); }}>
          <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            click to edit
          </div>
          <strong className="text-[#b87018]">User-facing TL;DR:</strong> {tldr}
        </div>
      ) : null}

      {editingFmField === 'summary_for_tutor' ? (
        <div className="mb-6 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
            <span className="font-medium text-sm text-blue-700">AI-facing summary</span>
            <button onClick={() => setEditingFmField(null)}
              className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
              Done
            </button>
          </div>
          <div ref={mountRef} style={{ minHeight: '40px' }} />
        </div>
      ) : frontmatter.get('summary_for_tutor') ? (
        <div className="mb-6 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
          onClick={() => { setEditingIndex(null); setEditingFmField('summary_for_tutor'); }}>
          <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            click to edit
          </div>
          <strong className="text-[#6a2d9b]">AI-facing summary:</strong> {frontmatter.get('summary_for_tutor')}
        </div>
      ) : null}

      {sections
        .map((section, i) => ({ section, i }))
        .filter(({ i }) => i >= visibleFrom && i < visibleTo)
        .map(({ section, i }) => {
        if (section.type === 'frontmatter') return null;

        const fields = parseFields(section.content);

        // Editing state — show CM editor
        if (editingIndex === i) {
          return (
            <div key={i} className="mb-7 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                <span className="font-medium text-sm text-blue-700">{section.label}</span>
                <button onClick={() => setEditingIndex(null)}
                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                  Done
                </button>
              </div>
              <div ref={mountRef} style={{ minHeight: '60px' }} />
            </div>
          );
        }

        // Text section
        if (section.type === 'text') {
          const content = fields.get('content') ?? '';
          return (
            <TextRenderer
              key={i}
              content={content}
              onStartEdit={() => startEditingSection(i)}
            />
          );
        }

        // Chat section
        if (section.type === 'chat') {
          const instructions = fields.get('instructions') ?? '';
          return (
            <ChatRenderer
              key={i}
              title={section.label}
              instructions={instructions}
              onStartEdit={() => startEditingSection(i)}
            />
          );
        }

        // Article segment — source inherits from previous article segment
        if (section.type === 'article') {
          let articleSource = fields.get('source')?.trim();
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          if (!articleSource) {
            for (let j = i - 1; j >= 0; j--) {
              if (sections[j].type === 'article') {
                const prevFields = parseFields(sections[j].content);
                const src = prevFields.get('source')?.trim();
                if (src) {
                  articleSource = src;
                  break;
                }
              }
            }
          }

          if (!articleSource) {
            return (
              <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Article segment missing source:: field (no preceding article to inherit from)
              </div>
            );
          }

          return (
            <ArticleRenderer
              key={i}
              fromAnchor={from}
              toAnchor={to}
              articleSourceWikilink={articleSource}
              lensSourcePath={lensPath}
            />
          );
        }

        // Video segment — source inherits from previous video segment
        if (section.type === 'video') {
          let videoSource = fields.get('source')?.trim();
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          if (!videoSource) {
            for (let j = i - 1; j >= 0; j--) {
              if (sections[j].type === 'video') {
                const prevFields = parseFields(sections[j].content);
                const src = prevFields.get('source')?.trim();
                if (src) {
                  videoSource = src;
                  break;
                }
              }
            }
          }

          if (!videoSource) {
            return (
              <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Video segment missing source:: field (no preceding video to inherit from)
              </div>
            );
          }

          return (
            <VideoRenderer
              key={i}
              fromTime={from}
              toTime={to}
              videoSourceWikilink={videoSource}
              lensSourcePath={lensPath}
            />
          );
        }

        // Question section
        if (section.type === 'question') {
          const content = fields.get('content') ?? '';
          const assessmentInstructions = fields.get('assessment-instructions');
          const enforceVoice = fields.get('enforce-voice');
          const maxChars = fields.get('max-chars');
          return (
            <QuestionRenderer
              key={i}
              content={content}
              assessmentInstructions={assessmentInstructions}
              enforceVoice={enforceVoice}
              maxChars={maxChars}
              onStartEdit={() => startEditingSection(i)}
            />
          );
        }

        // Page header
        if (section.type === 'page') {
          return (
            <HeadingRenderer
              key={i}
              label={section.label}
              fontSize={22}
              onStartEdit={() => startEditingSection(i)}
            />
          );
        }

        // Article/video reference heading and generic heading
        if (section.type === 'article-ref' || section.type === 'video-ref' || section.type === 'heading') {
          return (
            <HeadingRenderer
              key={i}
              label={section.label}
              onStartEdit={() => startEditingSection(i)}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
