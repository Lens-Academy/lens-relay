import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  MAX_OPTIONS,
  MIN_OPTIONS,
  QUESTION_SETTINGS,
  newQuestionProblem,
  type NewQuestion,
  type QuestionField,
} from '../../lib/idea-map';
import { GrowingTextarea } from './GrowingTextarea';
import { LEAVE_NOTE, saveKeys, useFormKeys } from './formKeys';
import { BUTTON, PRIMARY_BUTTON } from './ideaLook';

const LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400';
const TYPES = ['Open', 'Choice'] as const;
type QuestionType = NewQuestion['type'];

interface Option {
  /** Stays with the row while others are removed. */
  key: number;
  text: string;
  correct: boolean;
}

/** One further field of the question (`name:: value`). */
interface Setting extends QuestionField {
  key: number;
  /** Added in this form: its name can still be typed. */
  fresh: boolean;
}

/** What a new question starts with besides its boxes. */
const START_SETTINGS: Record<QuestionType, QuestionField[]> = { Open: [], Choice: [{ name: 'shuffle', value: 'true' }] };

/**
 * The creator's form for one question of an idea, in the side panel: a new
 * one ("Add question": an open question, graded, answered by the tutor or
 * both, or a choice question), or an existing one of these two types with
 * every field it has (`initial`, "Edit question"; its type cannot change).
 * Fields without a box of their own are listed under "More settings".
 *
 * By keyboard: the focus starts in the question; Enter in an option goes to
 * the next one (and adds one after the last); Ctrl/Cmd+Enter saves; Escape
 * closes (asking once when something is not saved).
 */
export function QuestionForm({ ideaName, initial, onCancel, onSubmit }: {
  ideaName: string;
  /** The question to edit, as `questionAsNew` gives it. */
  initial?: NewQuestion;
  onCancel: () => void;
  /** Add or save the question; resolves to an error to show, or null. */
  onSubmit: (question: NewQuestion) => Promise<string | null>;
}) {
  const editing = initial !== undefined;
  const id = useId();
  const [type, setType] = useState<QuestionType>(initial?.type ?? 'Open');
  const [content, setContent] = useState(initial?.content ?? '');
  const [assessment, setAssessment] = useState(initial?.type === 'Open' ? initial.assessment ?? '' : '');
  const [feedback, setFeedback] = useState(initial?.type === 'Open' ? initial.feedback ?? '' : '');
  const [options, setOptions] = useState<Option[]>(() => (initial?.type === 'Choice'
    ? initial.options.map((option, key) => ({ key, ...option }))
    : Array.from({ length: MIN_OPTIONS }, (_, key) => ({ key, text: '', correct: false }))));
  const [explanation, setExplanation] = useState(initial?.type === 'Choice' ? initial.explanation ?? '' : '');
  // The settings of each type, so switching the type of a new question loses none
  const [settings, setSettings] = useState<Record<QuestionType, Setting[]>>(() => {
    const start = (t: QuestionType) => (initial?.type === t ? initial.other ?? [] : editing ? [] : START_SETTINGS[t])
      .map((field, key) => ({ ...field, key, fresh: false }));
    return { Open: start('Open'), Choice: start('Choice') };
  });
  const [nextKey, setNextKey] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the form opened with: Escape asks before it discards anything else
  const now = JSON.stringify([type, content, assessment, feedback, options, explanation, settings]);
  const [start] = useState(now);
  const { onKeyDown, leaving } = useFormKeys({ dirty: now !== start, busy, onCancel });

  const setOption = (key: number, change: Partial<Option>) => {
    setOptions((all) => all.map((option) => (option.key === key ? { ...option, ...change } : option)));
  };
  // A row that is added (an option, a setting) is typed next: its first box takes the focus
  const rows = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState<number | null>(null);
  useEffect(() => {
    if (added !== null) rows.current?.querySelector<HTMLElement>(`[data-row="${added}"] :is(input:not([type="checkbox"]), textarea)`)?.focus();
  }, [added]);
  const addOption = () => {
    setOptions((all) => [...all, { key: nextKey, text: '', correct: false }]);
    setAdded(nextKey);
    setNextKey(nextKey + 1);
  };
  const shown = settings[type];
  const changeSettings = (change: (all: Setting[]) => Setting[]) => {
    setSettings((all) => ({ ...all, [type]: change(all[type]) }));
    setError(null);
  };
  const setSetting = (key: number, change: Partial<Setting>) => {
    changeSettings((all) => all.map((setting) => (setting.key === key ? { ...setting, ...change } : setting)));
  };
  const addSetting = () => {
    changeSettings((all) => [...all, { key: nextKey, name: '', value: '', fresh: true }]);
    setAdded(nextKey);
    setNextKey(nextKey + 1);
  };
  const hintFor = (name: string) => QUESTION_SETTINGS[type].find((known) => known.name === name.trim())?.hint;
  const unused = QUESTION_SETTINGS[type].filter((known) => !shown.some((setting) => setting.name.trim() === known.name));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const other = shown
      // A row added and left empty is no setting
      .filter((setting) => !setting.fresh || setting.name.trim() || setting.value.trim())
      .map(({ name, value }) => ({ name: name.trim(), value }));
    const question: NewQuestion = type === 'Open'
      ? { type, content, assessment, feedback, other }
      : { type, content, options: options.map(({ text, correct }) => ({ text, correct })), explanation, other };
    // An existing question is checked field by field when it is saved: a
    // field left as it is in the file is never refused (questionEditChanges)
    const problem = editing ? null : newQuestionProblem(question);
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

  const title = editing ? 'Edit question' : 'Add question';
  return (
    <form
      className="flex h-full flex-col"
      onSubmit={submit}
      onKeyDown={onKeyDown}
      // What it said is about the form as it was
      onChange={() => setError(null)}
      aria-label={title}
      data-testid="question-form"
    >
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-base font-semibold text-gray-800">{title}</h2>
        <p className="mt-0.5 break-words text-xs text-gray-500">{editing ? 'of' : 'to'} {ideaName}</p>
      </div>
      <div ref={rows} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="mt-4">
          <span id="question-type" className={LABEL}>Type</span>
          {editing ? (
            <p className="text-sm text-gray-800" aria-labelledby="question-type" data-testid="question-type">{type}</p>
          ) : (
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
          )}
        </div>
        <div className="mt-4">
          <label htmlFor="question-content" className={LABEL}>Question</label>
          <GrowingTextarea id="question-content" className="lens-input w-full" rows={3} autoFocus value={content} onChange={(e) => setContent(e.target.value)} />
        </div>

        {type === 'Open' ? (
          <>
            <div className="mt-4">
              <label htmlFor="question-assessment" className={LABEL}>How to grade it</label>
              <GrowingTextarea
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
              <GrowingTextarea
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
                  <li key={option.key} data-option={index + 1} data-row={option.key}>
                    <input
                      className="lens-input w-full"
                      aria-label={`Option ${index + 1}`}
                      placeholder={`Option ${index + 1}`}
                      autoComplete="off"
                      value={option.text}
                      onChange={(e) => setOption(option.key, { text: e.target.value })}
                      onKeyDown={(e) => {
                        // Enter after the last option: the next one (else Enter goes to the next field)
                        const last = index === options.length - 1;
                        if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || !last) return;
                        if (!option.text.trim() || options.length >= MAX_OPTIONS) return;
                        e.preventDefault();
                        // Drawn before the key is over: the next letter typed is in the new option
                        flushSync(addOption);
                      }}
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
                          onClick={() => {
                            setOptions((all) => all.filter((other) => other.key !== option.key));
                            setError(null);
                          }}
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
              <p className="mt-2 text-xs text-gray-500">
                Tick every right answer. With several ticked, learners may tick several too ("multi" is set to true).
              </p>
            </fieldset>
            <div className="mt-4">
              <label htmlFor="question-explanation" className={LABEL}>Explanation</label>
              <GrowingTextarea
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

        <fieldset className="mt-4" data-testid="question-settings">
          <legend className={LABEL}>More settings</legend>
          {shown.length === 0 && <p className="text-sm text-gray-400">None</p>}
          <ul className="space-y-2">
            {shown.map((setting) => {
              const label = setting.name.trim() || 'new setting';
              const hint = hintFor(setting.name);
              return (
                <li key={setting.key} data-setting={setting.name.trim()} data-row={setting.key}>
                  <div className="flex items-center justify-between gap-2 text-xs text-gray-600">
                    {setting.fresh ? (
                      <input
                        className="lens-input min-w-0 flex-1 font-mono text-xs"
                        aria-label="Name of the new setting"
                        placeholder="name, for example max-words"
                        autoComplete="off"
                        list={`${id}-settings`}
                        value={setting.name}
                        onChange={(e) => setSetting(setting.key, { name: e.target.value })}
                      />
                    ) : (
                      <span className="font-mono">{setting.name}</span>
                    )}
                    <button
                      type="button"
                      className="text-gray-500 hover:text-gray-800 hover:underline"
                      aria-label={`Remove setting ${label}`}
                      onClick={() => changeSettings((all) => all.filter((other) => other.key !== setting.key))}
                    >
                      Remove
                    </button>
                  </div>
                  <GrowingTextarea
                    className="lens-input mt-1 w-full"
                    aria-label={`Value of ${label}`}
                    rows={1}
                    value={setting.value}
                    onChange={(e) => setSetting(setting.key, { value: e.target.value })}
                  />
                  {hint && <p className="text-xs text-gray-400">{hint}</p>}
                </li>
              );
            })}
          </ul>
          <datalist id={`${id}-settings`}>
            {unused.map((known) => <option key={known.name} value={known.name}>{known.hint}</option>)}
          </datalist>
          <button type="button" className={`${BUTTON} mt-2`} onClick={addSetting}>Add setting</button>
          <p className="mt-2 text-xs text-gray-500">
            Every other field of the question, written as "name:: value". Emptying a value takes the field out.
          </p>
        </fieldset>

        {error && (
          <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3">
        {leaving && <p className="mr-auto text-xs text-amber-700" role="status" data-testid="form-leave-note">{LEAVE_NOTE}</p>}
        <button type="button" className={BUTTON} onClick={onCancel} disabled={busy} title="Escape">Cancel</button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy} title={saveKeys()}>
          {editing ? (busy ? 'Saving…' : 'Save') : (busy ? 'Adding…' : 'Add question')}
        </button>
      </div>
    </form>
  );
}
