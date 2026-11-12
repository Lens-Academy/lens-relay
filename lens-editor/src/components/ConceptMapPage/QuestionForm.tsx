import { useState, type FormEvent } from 'react';
import { MAX_OPTIONS, MIN_OPTIONS, newQuestionProblem, type NewQuestion } from '../../lib/idea-map';
import { BUTTON, PRIMARY_BUTTON } from './ideaLook';

const LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400';
const TYPES = ['Open', 'Choice'] as const;

interface Option {
  /** Stays with the row while others are removed. */
  key: number;
  text: string;
  correct: boolean;
}

/**
 * The creator's form for one new question of an idea, in the side panel:
 * an open question (graded, answered by the tutor, or both) or a choice
 * question. Existing questions are edited in the file itself.
 */
export function QuestionForm({ ideaName, onCancel, onSubmit }: {
  ideaName: string;
  onCancel: () => void;
  /** Add the question; resolves to an error to show, or null. */
  onSubmit: (question: NewQuestion) => Promise<string | null>;
}) {
  const [type, setType] = useState<NewQuestion['type']>('Open');
  const [content, setContent] = useState('');
  const [assessment, setAssessment] = useState('');
  const [feedback, setFeedback] = useState('');
  const [options, setOptions] = useState<Option[]>(() => Array.from({ length: MIN_OPTIONS }, (_, key) => ({ key, text: '', correct: false })));
  const [nextKey, setNextKey] = useState(MIN_OPTIONS);
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setOption = (key: number, change: Partial<Option>) => {
    setOptions((all) => all.map((option) => (option.key === key ? { ...option, ...change } : option)));
  };
  const addOption = () => {
    setOptions((all) => [...all, { key: nextKey, text: '', correct: false }]);
    setNextKey(nextKey + 1);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const question: NewQuestion = type === 'Open'
      ? { type, content, assessment, feedback }
      : { type, content, options: options.map(({ text, correct }) => ({ text, correct })), explanation };
    const problem = newQuestionProblem(question);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await onSubmit(question);
    // On success the page closes the form
    if (failed) {
      setError(failed);
      setBusy(false);
    }
  };

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={submit}
      // What it said is about the form as it was
      onChange={() => setError(null)}
      aria-label="Add question"
      data-testid="question-form"
    >
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-base font-semibold text-gray-800">Add question</h2>
        <p className="mt-0.5 break-words text-xs text-gray-500">to {ideaName}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="mt-4">
          <span id="question-type" className={LABEL}>Type</span>
          <div role="group" aria-labelledby="question-type" className="inline-flex items-center rounded bg-gray-200 p-0.5">
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={type === t}
                onClick={() => setType(t)}
                className={`rounded px-3 py-1 text-xs font-medium ${type === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <label htmlFor="question-content" className={LABEL}>Question</label>
          <textarea id="question-content" className="lens-input w-full" rows={3} autoFocus value={content} onChange={(e) => setContent(e.target.value)} />
        </div>

        {type === 'Open' ? (
          <>
            <div className="mt-4">
              <label htmlFor="question-assessment" className={LABEL}>How to grade it</label>
              <textarea
                id="question-assessment"
                className="lens-input w-full"
                rows={3}
                placeholder="Optional. For example: Score out of 100. 60: …; 40: …"
                value={assessment}
                onChange={(e) => setAssessment(e.target.value)}
              />
            </div>
            <div className="mt-4">
              <label htmlFor="question-feedback" className={LABEL}>How the tutor should respond</label>
              <textarea
                id="question-feedback"
                className="lens-input w-full"
                rows={3}
                placeholder="Optional"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>
            <p className="mt-2 text-xs text-gray-500">
              With a grading text the answer is scored. With a tutor text the learner gets feedback. Both may be filled.
            </p>
          </>
        ) : (
          <>
            <fieldset className="mt-4">
              <legend className={LABEL}>Options</legend>
              <ul className="space-y-2">
                {options.map((option, index) => (
                  <li key={option.key} data-option={index + 1}>
                    <input
                      className="lens-input w-full"
                      aria-label={`Option ${index + 1}`}
                      placeholder={`Option ${index + 1}`}
                      autoComplete="off"
                      value={option.text}
                      onChange={(e) => setOption(option.key, { text: e.target.value })}
                    />
                    <div className="mt-1 flex items-center justify-between text-xs text-gray-600">
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Option ${index + 1} is a right answer`}
                          checked={option.correct}
                          onChange={(e) => setOption(option.key, { correct: e.target.checked })}
                        />
                        Right answer
                      </label>
                      {options.length > MIN_OPTIONS && (
                        <button
                          type="button"
                          className="text-gray-500 hover:text-gray-800 hover:underline"
                          aria-label={`Remove option ${index + 1}`}
                          onClick={() => setOptions((all) => all.filter((other) => other.key !== option.key))}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {options.length < MAX_OPTIONS && (
                <button type="button" className={`${BUTTON} mt-2`} onClick={addOption}>Add option</button>
              )}
              <p className="mt-2 text-xs text-gray-500">Tick every right answer. Learners get the options in a mixed order.</p>
            </fieldset>
            <div className="mt-4">
              <label htmlFor="question-explanation" className={LABEL}>Explanation</label>
              <textarea
                id="question-explanation"
                className="lens-input w-full"
                rows={2}
                placeholder="Optional"
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
              />
            </div>
          </>
        )}

        {error && (
          <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
        <button type="button" className={BUTTON} onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>{busy ? 'Adding…' : 'Add question'}</button>
      </div>
    </form>
  );
}
