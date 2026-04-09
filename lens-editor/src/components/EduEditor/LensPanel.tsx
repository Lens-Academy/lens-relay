import { useEffect, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { PowerToolbar } from './PowerToolbar';
import { TutorInstructions } from './TutorInstructions';
import { ArticleEmbed } from './ArticleEmbed';
import { VideoExcerptEmbed } from './VideoExcerptEmbed';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';
import * as Y from 'yjs';

interface LensPanelProps {
  lensDocId: string;
  lensName: string;
}

export function LensPanel({ lensDocId, lensName }: LensPanelProps) {
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

  // Connect to lens doc
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(lensDocId);
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
  }, [lensDocId, getOrConnect]);

  if (!synced) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        Loading lens...
      </div>
    );
  }

  const tldr = frontmatter.get('tldr');

  return (
    <div>
      <PowerToolbar lensFileName={`${lensName}.md`} />

      {tldr && (
        <div className="mb-6 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed">
          <strong className="text-[#b87018]">TL;DR:</strong> {tldr}
        </div>
      )}

      {sections.map((section, i) => {
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
          const isQuestion = content.trim().length < 500 && content.trim().endsWith('?');

          if (isQuestion) {
            return (
              <div key={i} className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-lg"
                onClick={() => setEditingIndex(i)}>
                <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  click to edit
                </div>
                <div className="p-4 bg-white rounded-lg border border-[#e8e5df]" style={{ fontFamily: "'Newsreader', serif", fontSize: '17px', fontStyle: 'italic', lineHeight: 1.6, color: '#44403c' }}>
                  {content}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-md"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div className="text-[15px] leading-[1.75] text-gray-900 prose prose-sm max-w-none" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            </div>
          );
        }

        // Chat section
        if (section.type === 'chat') {
          const instructions = fields.get('instructions') ?? '';
          return (
            <TutorInstructions
              key={i}
              title={section.label}
              instructions={instructions}
              onEdit={() => setEditingIndex(i)}
            />
          );
        }

        // Article-excerpt section
        if (section.type === 'article-excerpt') {
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          // Find article source from nearest preceding article-ref heading
          let articleSource = '';
          for (let j = i - 1; j >= 0; j--) {
            if (sections[j].type === 'article-ref') {
              const headingFields = parseFields(sections[j].content);
              const src = headingFields.get('source');
              if (src) {
                articleSource = src.trim();
                break;
              }
            }
          }

          if (!articleSource) {
            return (
              <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Article-excerpt has no article source:: in a preceding heading
              </div>
            );
          }

          const lensUuid = lensDocId.slice(RELAY_ID.length + 1);
          const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';

          return (
            <ArticleEmbed
              key={i}
              fromAnchor={from}
              toAnchor={to}
              articleSourceWikilink={articleSource}
              lensSourcePath={lensPath}
            />
          );
        }

        // Video-excerpt section
        if (section.type === 'video-excerpt') {
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          // Find video source from nearest preceding video-ref heading
          let videoSource = '';
          for (let j = i - 1; j >= 0; j--) {
            if (sections[j].type === 'video-ref') {
              const headingFields = parseFields(sections[j].content);
              const src = headingFields.get('source');
              if (src) {
                videoSource = src.trim();
                break;
              }
            }
          }

          if (!videoSource) {
            return (
              <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Video-excerpt has no video source:: in a preceding heading
              </div>
            );
          }

          const lensUuid = lensDocId.slice(RELAY_ID.length + 1);
          const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';

          return (
            <VideoExcerptEmbed
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
            <div key={i} className="mb-7 p-4 bg-white rounded-lg border border-[#e8e5df] relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-wider text-orange-700 font-semibold">Question</span>
                {enforceVoice === 'true' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600">voice</span>
                )}
                {maxChars && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">max {maxChars} chars</span>
                )}
              </div>
              <div className="text-sm text-gray-700 mb-2">{content}</div>
              {assessmentInstructions && (
                <div className="mt-2 pt-2 border-t border-gray-100">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Assessment Instructions</div>
                  <div className="text-xs text-gray-500 leading-relaxed">{assessmentInstructions}</div>
                </div>
              )}
            </div>
          );
        }

        // Page header
        if (section.type === 'page') {
          return (
            <div key={i} className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div style={{ fontFamily: "'Newsreader', serif", fontSize: '22px', fontWeight: 600, color: '#1a1a1a' }}>
                {section.label}
              </div>
            </div>
          );
        }

        // Article/Video reference heading
        if (section.type === 'article-ref' || section.type === 'video-ref') {
          return (
            <div key={i} className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div style={{ fontFamily: "'Newsreader', serif", fontSize: '18px', fontWeight: 600, color: '#1a1a1a' }}>
                {section.label}
              </div>
            </div>
          );
        }

        // Generic heading
        if (section.type === 'heading') {
          return (
            <div key={i} className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div style={{ fontFamily: "'Newsreader', serif", fontSize: '18px', fontWeight: 600, color: '#1a1a1a' }}>
                {section.label}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
