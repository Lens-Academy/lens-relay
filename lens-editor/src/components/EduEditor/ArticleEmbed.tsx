// src/components/EduEditor/ArticleEmbed.tsx
import { useEffect, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';
import * as Y from 'yjs';

interface ArticleEmbedProps {
  fromAnchor?: string;
  toAnchor?: string;
  articleSourceWikilink: string;
  lensSourcePath: string;
}

export function ArticleEmbed({ fromAnchor, toAnchor, articleSourceWikilink, lensSourcePath }: ArticleEmbedProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [excerptText, setExcerptText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [articleTitle, setArticleTitle] = useState<string>('Article');
  const [editing, setEditing] = useState(false);
  const [excerptRange, setExcerptRange] = useState<{ from: number; to: number } | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const ytextRef = useRef<Y.Text | null>(null);

  const { mountRef } = useSectionEditor({
    ytext: ytextRef.current,
    sectionFrom: excerptRange?.from ?? 0,
    sectionTo: excerptRange?.to ?? 0,
    active: editing,
  });

  useEffect(() => {
    const name = articleSourceWikilink
      .replace(/^!?\[\[/, '').replace(/\]\]$/, '')
      .split('/').pop()?.split('|')[0] ?? 'Article';
    setArticleTitle(name);
  }, [articleSourceWikilink]);

  // Connect to article doc and extract excerpt
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const uuid = resolveWikilinkToUuid(articleSourceWikilink, lensSourcePath, metadata);
      if (!uuid) {
        setError(`Could not resolve: ${articleSourceWikilink}`);
        return;
      }

      const compoundId = `${RELAY_ID}-${uuid}`;
      const { doc } = await getOrConnect(compoundId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      ytextRef.current = ytext;

      const update = () => {
        // Skip updates while CM editor is active — ySectionSync handles bidirectional sync,
        // and re-extracting the excerpt would cause unnecessary re-renders.
        if (editingRef.current) return;

        const fullText = ytext.toString();

        // Dynamic import to avoid ESM/CJS issues
        import('lens-content-processor/dist/bundler/article.js').then(({ extractArticleExcerpt, stripFrontmatter }) => {
          if (cancelled) return;
          const result = extractArticleExcerpt(fullText, fromAnchor, toAnchor, 'article');

          if (result.error) {
            setError(result.error.message);
            setExcerptText(null);
            setExcerptRange(null);
          } else if (result.content) {
            setExcerptText(result.content);
            setError(null);

            // Calculate absolute Y.Text offsets
            const body = stripFrontmatter(fullText);
            const fmOffset = fullText.indexOf(body);
            setExcerptRange({
              from: fmOffset + (result.startIndex ?? 0),
              to: fmOffset + (result.endIndex ?? body.length),
            });
          }
        });
      };

      update();
      ytext.observe(update);

      return () => ytext.unobserve(update);
    }

    setExcerptText(null);
    setError(null);
    setEditing(false);
    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [articleSourceWikilink, lensSourcePath, fromAnchor, toAnchor, metadata, getOrConnect]);

  return (
    <div className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
      style={{ background: 'rgba(184, 112, 24, 0.04)' }}>
      <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
        <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
          {articleTitle}
        </div>
      </div>

      <div className="px-6 py-5">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
        )}

        {!error && !excerptText && (
          <div className="text-sm text-gray-400 italic">Loading excerpt...</div>
        )}

        {!error && excerptText && !editing && (
          <div className="relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
            onClick={() => setEditing(true)}>
            <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              click to edit
            </div>
            <div className="text-gray-400 tracking-wider mb-1">&hellip;</div>
            <div className="text-[14px] leading-[1.8] text-gray-700 prose prose-sm max-w-none" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              <ReactMarkdown>{excerptText}</ReactMarkdown>
            </div>
            <div className="text-gray-400 tracking-wider mt-1">&hellip;</div>
          </div>
        )}

        {!error && editing && (
          <div className="rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
              <span className="font-medium text-sm text-blue-700">Editing: {articleTitle}</span>
              <button onClick={() => setEditing(false)}
                className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                Done
              </button>
            </div>
            <div ref={mountRef} style={{ minHeight: '60px' }} />
          </div>
        )}
      </div>
    </div>
  );
}
