// Which text goes into a run: courses and kinds of text, and where that text comes from.
import { useState } from 'react';
import type { CorpusMeta, Para } from './types';

function toggled(set: Set<string>, k: string) {
  const out = new Set(set);
  if (out.has(k)) out.delete(k); else out.add(k);
  return out;
}

function Check({ on, onToggle, title, children }: { on: boolean; onToggle: () => void; title?: string; children: React.ReactNode }) {
  return (
    <label className="mr-3 inline-block whitespace-nowrap" title={title}>
      <input type="checkbox" className="mr-1 align-middle" checked={on} onChange={onToggle} />{children}
    </label>
  );
}

export function InputPicker({ meta, pool, n, courses, kinds, onCourses, onKinds }: {
  meta: CorpusMeta; pool: Para[]; n: number; courses: Set<string>; kinds: Set<string>;
  onCourses: (s: Set<string>) => void; onKinds: (s: Set<string>) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = Object.entries(meta.courses).filter(([k, c]) => c.paragraphs && (all || c.live || courses.has(k)))
    .sort(([, a], [, b]) => Number(b.live) - Number(a.live) || b.paragraphs - a.paragraphs);
  const inSample: Record<string, number> = {};
  for (const p of pool.slice(0, n)) for (const c of p.courses) if (courses.has(c)) inSample[c] = (inSample[c] ?? 0) + 1;
  return (
    <div className="w-full space-y-2 text-[12px] text-gray-600">
      <div>
        <span className="mr-2 text-gray-500">courses</span>
        {shown.map(([k, c]) => (
          <Check key={k} on={courses.has(k)} onToggle={() => onCourses(toggled(courses, k))}
            title={`${c.paragraphs} paragraphs in ${c.files} files${c.live ? '; has a running cohort' : ''}`}>
            {c.title}{c.live && <span className="text-emerald-600"> ●</span>}
            <span className="text-gray-400"> {courses.has(k) ? `${inSample[k] ?? 0}/` : ''}{c.paragraphs}</span>
          </Check>
        ))}
        <button onClick={() => setAll(!all)} className="text-gray-400 hover:underline">{all ? 'fewer' : `all ${Object.keys(meta.courses).length}`}</button>
      </div>
      <div>
        <span className="mr-2 text-gray-500">text</span>
        {Object.entries(meta.kinds).map(([k, count]) => (
          <Check key={k} on={kinds.has(k)} onToggle={() => onKinds(toggled(kinds, k))}>
            {k}<span className="text-gray-400"> {count}</span>
          </Check>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-gray-500">where this text comes from</summary>
        <p className="mt-1 leading-relaxed">{meta.source} Built {meta.taken}. ● marks a course with a running cohort. The
          numbers after a course are paragraphs in this sample / in the course. Paragraphs are in one fixed shuffled order,
          so the first N are the same on every run and a larger N only adds paragraphs.</p>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-gray-500">
          staging course → its pages (staging API) → each file at lens-edu-staging {meta.commit} → the live check's
          paragraph splitter → sample → /api/jev/ask (answers cached on disk) → jev → score per paragraph</p>
      </details>
    </div>
  );
}
