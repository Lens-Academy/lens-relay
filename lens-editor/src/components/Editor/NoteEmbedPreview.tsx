import { renderMarkdownWithCriticMarkup } from '../../lib/criticmarkup-render';
import { parseQuestionFile, stripFrontmatter } from '../../lib/questionFile';

/** Longest text a preview renders; the rest is cut (the card is capped anyway). */
export const MAX_PREVIEW_CHARS = 20_000;

/** Field labels shown under a question's prompt, in this order; others follow. */
const QUESTION_FIELD_ORDER = [
  'options',
  'items',
  'scale',
  'labels',
  'assessment-instructions',
  'feedback-instructions',
  'force-feedback',
  'optional',
];
const HIDDEN_FIELDS = new Set(['id', 'content']);

function clip(text: string): string {
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text;
}

/** Choice options (`- [x] right`, `- [ ] wrong`) and ranking items as a
 *  compact list; other values as Markdown. */
function renderFieldValue(key: string, value: string) {
  const items = value.split('\n').map((line) => /^\s*[-*]\s+(?:\[([ xX])\]\s*)?(.*)$/.exec(line));
  if ((key === 'options' || key === 'items') && items.length > 0 && items.every(Boolean)) {
    return (
      <ul className="cm-note-embed-options">
        {items.map((m, i) => (
          <li key={i} className={m![1]?.toLowerCase() === 'x' ? 'cm-note-embed-correct' : undefined}>
            {key === 'options' ? (m![1]?.toLowerCase() === 'x' ? '✓ ' : '○ ') : `${i + 1}. `}
            {m![2]}
          </li>
        ))}
      </ul>
    );
  }
  return renderMarkdownWithCriticMarkup(clip(value));
}

/** Read-only rendering of an embedded file: question-shaped for a question
 *  file, plain Markdown otherwise. Pending suggestions render inline. */
export function NoteEmbedPreview({ text }: { text: string }) {
  const question = parseQuestionFile(text);
  if (!question) {
    const body = stripFrontmatter(text).trim();
    if (!body) return <div className="cm-note-embed-empty">Empty file</div>;
    return <div className="cm-note-embed-markdown">{renderMarkdownWithCriticMarkup(clip(body))}</div>;
  }

  const content = question.fields.get('content') ?? '';
  const rest = [...question.fields.keys()]
    .filter((key) => !HIDDEN_FIELDS.has(key))
    .sort((a, b) => {
      const ia = QUESTION_FIELD_ORDER.indexOf(a);
      const ib = QUESTION_FIELD_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  return (
    <div className="cm-note-embed-question">
      <div className="cm-note-embed-kind">Question · {question.type}</div>
      <div className="cm-note-embed-prompt">
        {content ? renderMarkdownWithCriticMarkup(clip(content)) : <em>No content:: yet</em>}
      </div>
      {rest.length > 0 && (
        <dl className="cm-note-embed-fields">
          {rest.map((key) => (
            <div key={key} className="cm-note-embed-field">
              <dt>{key}</dt>
              <dd>{renderFieldValue(key, question.fields.get(key) ?? '')}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
