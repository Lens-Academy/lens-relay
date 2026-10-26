// The runs of one visit to a check: each with the run it is compared with.
import type { Run } from './types';

export interface RunEntry { run: Run; draft: boolean; base?: { label: string; run: Run } }

/** What a new run over the sample `key` is compared with: the live check's run of it when the
 *  draft ran, else the newest earlier run over the same paragraphs (Assay, #195: another
 *  sample's shares do not compare). */
export function baseFor(runs: RunEntry[], key: string, live: Run | null): RunEntry['base'] {
  if (live) return { label: 'live', run: live };
  const was = [...runs].reverse().find((e) => e.run.sample === key);
  return was && { label: 'was', run: was.run };
}
