import { useEffect, useState, useRef } from 'react';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { PowerToolbar } from './PowerToolbar';
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

export function ContentPanel({ scope }: ContentPanelProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [sections, setSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Map<string, string>>(new Map());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);

  const activeSection = editingIndex !== null
    ? parseSections(ytextRef.current?.toString() ?? '')[editingIndex] ?? null
    : null;

  const { mountRef } = useSectionEditor({
    ytext: ytextRef.current,
    sectionFrom: activeSection?.from ?? 0,
    sectionTo: activeSection?.to ?? 0,
    active: editingIndex !== null,
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
      {scope.kind === 'full-doc' ? (
        <PowerToolbar lensFileName={`${scope.docName}.md`} />
      ) : (
        <div className="flex items-center gap-2 mb-6 px-3 py-2 bg-white rounded-lg border border-[#e8e5df] text-xs text-gray-500">
          <span className="px-2.5 py-0.5 rounded-xl bg-gray-900 text-white font-medium">Edit</span>
          <span className="text-[11px] text-gray-500">{scope.docName}</span>
          <span className="text-[11px] text-gray-400">&middot; {scope.breadcrumb}</span>
        </div>
      )}

      {tldr && (
        <div className="mb-6 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed">
          <strong className="text-[#b87018]">TL;DR:</strong> {tldr}
        </div>
      )}

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
              onStartEdit={() => setEditingIndex(i)}
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
              onStartEdit={() => setEditingIndex(i)}
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
              onStartEdit={() => setEditingIndex(i)}
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
              onStartEdit={() => setEditingIndex(i)}
            />
          );
        }

        // Article/video reference heading and generic heading
        if (section.type === 'article-ref' || section.type === 'video-ref' || section.type === 'heading') {
          return (
            <HeadingRenderer
              key={i}
              label={section.label}
              onStartEdit={() => setEditingIndex(i)}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
