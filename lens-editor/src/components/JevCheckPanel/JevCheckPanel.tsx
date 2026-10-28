// Check workbench, shown above a Lens Edu/Checks/*.md file. Read top-down:
//   the check's words (Field.tsx) are edited as a `draft:` block in the file's frontmatter
//   (checkFile.ts, lib/jev-check.ts); Save makes the draft live, Discard drops it;
//   the run bar picks a sample (useCorpus.ts, InputPicker.tsx; its settings live in the file's `view:` block,
//   useView.ts) and the check's presentation (lib/jev-presentation.ts, PresentationPicker.tsx, a draft field);
//   the platform builds the jev calls (/api/jev/requests) and the server asks jev (/api/jev/ask, server/jev/routes.ts);
//   results (Results.tsx) compare the draft with the live check, or a run with the one before it.
import { useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { discardDraft, parseCheckFile, parsePercentiles, platformProblems, platformWordProblems, readView, saveDraft, setCheckFields, setDraftField, setDraftPresentation, type Band } from '../../lib/jev-check';
import { COLORMAPS, type ColormapName } from '../../lib/colormaps';
import { useLiveText } from './checkFile';
import { writeText } from '../../lib/ytext';
import { chosen, poolOf, useCorpus } from './useCorpus';
import { useView } from './useView';
import { Field, Small } from './Field';
import { keyHint, refProblem, refSyntax, renameRef, unitNames } from '../../lib/jev-keys';
import { InputPicker } from './InputPicker';
import { NewCheckButton } from './NewCheckButton';
import { BandList, Histogram, Percentiles, Summary, type Labeler } from './Results';
import { labelBody } from '../../lib/jev-labels';
import { useLabels } from './useLabels';
import { EditableText } from './editable';
import { CountInput } from './CountInput';
import { RunChips } from './RunChips';
import { baseFor, type RunEntry } from './runs';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import type { CorpusMeta, Para } from './types';
import { DEFAULT_PRESENTATION, LEVELS, type Level, type Presentation } from '../../lib/jev-presentation';
import { PresentationPicker } from './PresentationPicker';
import { askCheck, type Batch } from '../../lib/jev-run';
import { relayHeaders } from '../../lib/relay-api';

// Percentile stops, the lower half; the upper half mirrors them (percentileRows).
const PCT_PRESETS: [string, string][] = [
  ['tens and thirds', '[0, 0.01, 0.03, 0.1, 0.3, 0.5]'],
  ['every tenth', '[0, 0.1, 0.2, 0.3, 0.4, 0.5]'],
  ['every twentieth', '[0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]'],
];
const DEFAULT_PCTS = PCT_PRESETS[0][1];

function attempt<T>(f: () => T): { ok?: T; error?: string } {
  try { return { ok: f() }; } catch (e) { return { error: (e as Error).message }; }
}

const post = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: relayHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};

export function JevCheckPanel({ ytext }: { ytext: Y.Text }) {
  const text = useLiveText(ytext);
  const parsed = useMemo(() => attempt(() => parseCheckFile(text)), [text]);
  const [err, setErr] = useState<string | null>(null);
  const corpus = useCorpus(setErr);
  // Use latest course text on every Run (Lauren, 2026-10-26). Off: the corpus stays as loaded,
  // and paragraphs cannot be opened for editing, since the live file may differ from it.
  const [latestText, setLatestText] = useState(true);
  // The view everyone who opens this file shares (useView.ts).
  const [n, setN] = useView(ytext, text, 'sample', 200);
  const [pctSpec, setPctSpec] = useView(ytext, text, 'percentiles', DEFAULT_PCTS);
  const pcts = useMemo(() => attempt(() => parsePercentiles(pctSpec)), [pctSpec]);
  const [cmapName, setCmap] = useView(ytext, text, 'colours', 'inferno');
  const cmap = (cmapName in COLORMAPS ? cmapName : 'inferno') as ColormapName;
  const [courses, setCourses] = useView(ytext, text, 'courses', [] as string[]);
  const [kinds, setKinds] = useView(ytext, text, 'kinds', [] as string[]);
  const viewCourses = readView(text).courses, viewKinds = readView(text).kinds;
  const [running, setRunning] = useState(false);
  // Every run of this visit, each with the run it is compared with; the newest is shown unless a
  // chip picks another (Lauren, 2026-10-26: toggle between runs of the same sample).
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const result = runs.length ? runs[shown ?? runs.length - 1] : null;
  const [band, setBand] = useState<Band | null>(null);
  const [showSent, setShowSent] = useState(false);
  const [sent, setSent] = useState<Batch | undefined>();

  const live = parsed.ok?.live;
  const draft = parsed.ok?.draft ?? null;
  const c = draft ?? live;  // what the fields show and Run tests
  const pres = c?.presentation ?? DEFAULT_PRESENTATION;
  const pool = useMemo(() => poolOf(corpus.corpus, corpus.meta, viewCourses && courses, viewKinds && kinds), [corpus.corpus, corpus.meta, courses, kinds, viewCourses, viewKinds]);
  async function run() {
    if (!c || !live || !pool) return;
    setRunning(true); setErr(null);
    try {
      // With latest course text, every Run first takes the corpus as the text is now.
      const askAll = async (fresh: { corpus: Para[] | null; meta: CorpusMeta | null }) => {
        const sample = (poolOf(fresh.corpus, fresh.meta, viewCourses && courses, viewKinds && kinds) ?? []).slice(0, n);
        const commit = fresh.meta?.commit;
        // Each check as it would be asked: the draft and the live check may differ in presentation.
        const [r, l] = await Promise.all([askCheck(post, c, sample, pres, commit), draft ? askCheck(post, live, sample, live.presentation, commit) : null]);
        return { r, l, key: sample.map((u) => u.id).join('\n') };
      };
      let got;
      try {
        got = await askAll(latestText ? await corpus.reload() : { corpus: corpus.corpus, meta: corpus.meta });
      } catch (e) {
        // The server no longer holds this corpus's texts (a restart, or newer corpora since).
        if (!(e as Error).message.startsWith('reload:')) throw e;
        if (!latestText) throw new Error(`The texts of rev ${corpus.meta?.commit} are no longer held by the editor server; turn "latest course text" on to load the course text again.`);
        got = await askAll(await corpus.reload());
      }
      const { r, l, key } = got;
      setSent(r.first);
      const mine = { ...r, sample: key }, draftRun = !!draft;
      setRuns((rs) => [...rs, { run: mine, draft: draftRun, base: baseFor(rs, key, l && { ...l, sample: key }) }]);
      setShown(null);
    } catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  }

  // "---" anywhere in the frontmatter cuts it short for the platform, which then drops the
  // LIVE check, even when the "---" is only in a draft field.
  const set = (path: string[]) => (v: string) => {
    if (v.includes('---')) { window.alert('"---" cannot go in a check field: the platform reads it as the end of the frontmatter.'); return; }
    writeText(ytext, (t) => setDraftField(t, path, v));
  };
  // The presentation is a draft field. A new question level also renames references to the old
  // one in the check's words, in the same write, so the words and the presentation agree.
  const changePres = (np: Presentation) => {
    if (!c) return;
    const from = pres.question, to = np.question;
    const fields: [string[], string][] = [[['question'], c.question], ...(c.criteria ? [[['criteria', 'true'], c.criteria.true], [['criteria', 'false'], c.criteria.false]] as [string[], string][] : [])];
    const renamed = from === to ? [] : fields.filter(([, v]) => renameRef(v, from, to) !== v);
    writeText(ytext, (t) => renamed.reduce((acc, [path, v]) => setDraftField(acc, path, renameRef(v, from, to)), setDraftPresentation(t, np)));
  };
  // Level names in the words that the presentation cannot resolve, and that renaming to the
  // asked-about level would fix: one click does it (Assay, deploy gate: T1's draft named
  // `sentence` while asking about paragraphs, with no way back but retyping).
  const fields: [string[], string][] = c ? [[['question'], c.question], ...(c.criteria ? [[['criteria', 'true'], c.criteria.true], [['criteria', 'false'], c.criteria.false]] as [string[], string][] : [])] : [];
  const strays = [...new Set(fields.flatMap(([, v]) => unitNames(v)).filter((n) => (LEVELS as string[]).includes(n) && n !== pres.question && refProblem(n, pres) !== null))];
  const renameTo = (from: string) => writeText(ytext, (t) => fields.filter(([, v]) => renameRef(v, from as Level, pres.question) !== v)
    .reduce((acc, [path, v]) => setDraftField(acc, path, renameRef(v, from as Level, pres.question)), t));
  const setNum = (path: string[]) => (v: string) => { const x = Number(v); if (Number.isFinite(x)) writeText(ytext, (t) => setDraftField(t, path, x)); };
  // What the platform would make of the file now (and so after Enable), and after Save.
  const nowProblems = useMemo(() => platformProblems(text), [text]);
  // Problems with the words leave the check running (badly); the rest drop it.
  const nowWords = useMemo(() => platformWordProblems(text), [text]);
  const dropped = nowProblems.filter((p) => !nowWords.includes(p));
  const saveProblems = useMemo(() => attempt(() => platformProblems(saveDraft(text))).ok ?? ['the draft cannot be saved'], [text]);
  const latest = result?.run;
  // Labels are the platform's judgements (lib/jev-labels.ts); a click adds one for the check run.
  const { displayName } = useDisplayName();
  const labels = useLabels(latest?.check.id);
  const labeler: Labeler | undefined = latest && {
    labels: labels.labels,
    error: labels.error,
    onLabel: (item, verdict) => labels.add(labelBody(latest.check.id, { ...item, unit: latest.unit }, verdict, displayName || 'someone')),
  };
  // The banner and the draft bar are about the newest run; an older one is only being looked at.
  const newest = runs.length ? runs[runs.length - 1].run : undefined;
  const older = shown !== null && shown < runs.length - 1;
  const stale = !older && newest && c && JSON.stringify(newest.check) !== JSON.stringify(c);
  const color = COLORMAPS[cmap];

  // contain:inline-size: the panel takes the editor's width and never sets it. Its one-line texts
  // (truncated hints, the can't-save line) would otherwise widen CodeMirror's content to their
  // full length, 700 px on a phone (Lauren, 2026-10-25).
  return (
    // Wider than the 580 px text column where the window allows (Lauren, 2026-10-26): the page area
    // is a CSS container (lens-page, index.css), so the panel takes its width less a margin, up to
    // 1100 px, never less than the column, and stays centred on the column.
    <section className="relative left-1/2 my-4 -translate-x-1/2 rounded-lg border border-gray-200 bg-white text-sm shadow-sm [contain:inline-size]" data-testid="jev-check-panel"
      style={{ width: 'max(100%, min(1100px, 100cqw - 64px))' }}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}>
      <EditableText.Provider value={latestText}>
      <header className="flex items-baseline justify-between border-b border-gray-100 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-gray-800">Jev check {c && <span className="font-normal text-gray-500">· {c.id}</span>}</span>
        <span className="flex items-baseline gap-3">
          {!c && <span className="text-red-700">{parsed.error}</span>}
          {live && !live.enabled && (
            <span className="text-[12px] font-normal text-amber-800">not live yet
              <button onClick={() => writeText(ytext, (t) => setCheckFields(t, [{ path: ['enabled'], value: true }]))}
                disabled={nowProblems.length > 0} title={nowProblems.join('\n')}
                className="ml-2 rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50">Enable</button></span>
          )}
          <NewCheckButton />
        </span>
      </header>

      {c && live && (
        <div className="space-y-3 px-4 py-3">
          {live.enabled && dropped.length > 0 && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-800">The platform cannot read this check as it is, so it is not running: {dropped.join('; ')}.</div>
          )}
          {live.enabled && !dropped.length && nowWords.length > 0 && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-800">The platform runs this check, but its words name units jev is never shown, so its answers mean little: {nowWords.join('; ')}.</div>
          )}
          <DraftBar draft={!!draft} problems={saveProblems} lastRun={newest?.platform === false ? 'Your last run was an experiment, not how the platform asks.' : undefined} onSave={() => writeText(ytext, saveDraft)} onDiscard={() => writeText(ytext, discardDraft)} />
          <Field label="Question" value={c.question} live={live.question} onCommit={set(['question'])} hint={keyHint(c.question, pres)} shape={pres} />
          <Field label="Yes means" value={c.criteria?.true ?? ''} live={live.criteria?.true ?? ''} onCommit={set(['criteria', 'true'])} shape={pres} />
          <Field label="No means" value={c.criteria?.false ?? ''} live={live.criteria?.false ?? ''} onCommit={set(['criteria', 'false'])} shape={pres} />
          <div className="px-1 text-[12px] text-gray-500">{refSyntax(pres)}
            {strays.map((n) => (
              <button key={n} onClick={() => renameTo(n)} className="ml-2 rounded border border-amber-300 bg-amber-50 px-1.5 text-amber-900 hover:bg-amber-100">
                rename `{n}` to `{pres.question}`</button>
            ))}</div>
          <div className="flex flex-wrap items-end gap-4 text-[13px] text-gray-600">
            <Small label="model" value={c.model} live={live.model} onCommit={set(['model'])} width="w-28" />
            <Small label="fail at" value={String(c.fail_at)} live={String(live.fail_at)} onCommit={setNum(['fail_at'])} width="w-14" />
            <Small label="pass below" value={String(c.pass_below)} live={String(live.pass_below)} onCommit={setNum(['pass_below'])} width="w-14" />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5 text-[13px] text-gray-600">
        <label>sample <CountInput value={n} max={pool?.length ?? 1000} onValue={setN} />
          {pool && <span className="text-gray-400"> / {pool.length}</span>}</label>
        <label className="flex min-w-[300px] flex-1 items-center gap-1">percentiles
          <select aria-label="percentile preset" value={PCT_PRESETS.find(([, v]) => v === pctSpec)?.[1] ?? ''} onChange={(e) => e.target.value && setPctSpec(e.target.value)}
            className="rounded border border-gray-200">
            {PCT_PRESETS.map(([name, v]) => <option key={name} value={v}>{name}</option>)}
            <option value="">custom</option></select>
          <input value={pctSpec} onChange={(e) => setPctSpec(e.target.value)} title={pcts.error ?? 'stops from 0 to 0.5; the upper half mirrors them, and a small sample takes the next free item in from each end'}
            className={`min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono text-xs ${pcts.error ? 'border-red-400' : 'border-gray-200'}`} /></label>
        <button onClick={run} disabled={running || !c || !pool?.length || !!pcts.error} title="Ctrl/Cmd+Enter"
          className="rounded-md bg-gray-900 px-4 py-1.5 font-medium text-white hover:bg-gray-700 disabled:opacity-40">{running ? 'Asking jev…' : 'Run'}</button>
        <label>colours <select value={cmap} onChange={(e) => setCmap(e.target.value as ColormapName)} className="ml-1 rounded border border-gray-200">
          {Object.keys(COLORMAPS).map((k) => <option key={k}>{k}</option>)}</select></label>
        <PresentationPicker value={pres} onChange={changePres} showSent={showSent} onShowSent={setShowSent} />
        {corpus.meta && pool && (
          <InputPicker meta={corpus.meta} pool={pool} n={n} {...chosen(corpus.meta, viewCourses && courses, viewKinds && kinds)}
            onCourses={(x) => setCourses([...x])} onKinds={(x) => setKinds([...x])} />
        )}
        <label className="flex items-center gap-1" title="Use the latest course text on every Run? Off keeps this text, so runs compare, and paragraphs cannot be opened for editing.">
          <input type="checkbox" checked={latestText} onChange={(e) => setLatestText(e.target.checked)} /> latest course text
          {corpus.meta && <span className="text-gray-400">{latestText ? 'using latest' : `using rev ${corpus.meta.commit}`}</span>}
        </label>
      </div>

      {err && <div className="px-4 py-2 text-red-700">{err}</div>}
      {showSent && sent && (
        <pre className="mx-4 my-2 max-h-96 overflow-auto rounded bg-gray-900 p-3 text-[11px] leading-snug text-gray-100">
          {JSON.stringify({ model: c?.model, state: sent.state, questions: Object.fromEntries(sent.questions.map((q, i) => [`q${i}`, { type: 'noul', ...q }])) }, null, 2)}
        </pre>
      )}
      {latest && (
        <div className="px-4 pb-4 pt-3">
          {older && <div className="mb-2 rounded bg-gray-100 px-2 py-1 text-gray-700">Showing run #{shown + 1} of {runs.length}, an earlier run.</div>}
          {stale && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-amber-800">The check changed since this run. Run again to see the new phrasing.</div>}
          {latest.platform === false && (
            <div className="mb-2 rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[13px] text-violet-900">
              Experiment: the platform does not ask this way. It asks about each paragraph alone, so scores here can differ from what agents will see after Save.</div>
          )}
          <RunChips runs={runs} shown={shown ?? runs.length - 1} onShow={(i) => { setShown(i === runs.length - 1 ? null : i); setBand(null); }} />
          {!!latest.leftOut && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[13px] text-amber-900">
            {latest.leftOut} sampled paragraph{latest.leftOut === 1 ? '' : 's'} not asked: the platform found nothing to ask about there in the file as it is now (usually it changed since the corpus was built).</div>}
          {!!latest.tooLong && <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[13px] text-amber-900">
            {latest.tooLong} left out: jev refused them as too long (the whole file is too big for jev here).</div>}
          {latest.pres && <div className="mb-1 text-[12px] text-gray-500">{latest.pres}
            {result?.base?.run.pres && result.base.run.pres !== latest.pres && <> · compared with a run where {result.base.run.pres.replace(/^jev /, '')}</>}</div>}
          {labels.error && <div className="text-[12px] text-red-700">{labels.error}</div>}
          <Summary run={latest} base={result?.base} band={band} onBand={(b) => setBand(band === b ? null : b)} labels={labeler?.labels} />
          <Histogram run={latest} color={color} />
          {band
            ? <BandList run={latest} band={band} color={color} onClear={() => setBand(null)} labeler={labeler} />
            : <Percentiles run={latest} pcts={pcts.ok ?? []} color={color} labeler={labeler} />}
        </div>
      )}
      </EditableText.Provider>
    </section>
  );
}

// Always shown, the same size with or without a draft or problems, so nothing here moves the page:
// a line of text, then a line with the buttons and (truncated, full on hover) why Save is off.
function DraftBar({ draft, problems, lastRun, onSave, onDiscard }: { draft: boolean; problems: string[]; lastRun?: string; onSave: () => void; onDiscard: () => void }) {
  return (
    <div className={`space-y-1.5 rounded-md px-3 py-2 text-[13px] ${draft ? 'bg-amber-50 text-amber-900' : 'bg-gray-50 text-gray-500'}`}>
      <div>{draft ? 'This file has a draft: Run tests it beside the live check.' : 'No draft: edits here make one beside the live check.'}
        {' '}Save makes it live: staging agents after the next content sync (about a minute), production after a promote.
        {draft && lastRun && <b> {lastRun}</b>}</div>
      {/* The reason has its own two lines above the buttons, always there, so nothing moves (Assay: it
          was cut off even at 1400 px when it shared the buttons' row). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="line-clamp-2 min-h-[2.5rem] w-full text-red-800" title={problems.join('\n')}>
          {draft && problems.length > 0 ? `can't save: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}` : ''}</span>
        <button onClick={onDiscard} disabled={!draft} className="shrink-0 rounded border border-amber-300 px-3 py-1 hover:bg-amber-100 disabled:opacity-40">Discard draft</button>
        <button onClick={onSave} disabled={!draft || problems.length > 0}
          className="shrink-0 rounded bg-amber-700 px-3 py-1 font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50">Save as live</button>
      </div>
    </div>
  );
}
