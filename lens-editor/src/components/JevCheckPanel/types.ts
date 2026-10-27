// The workbench's data: corpus rows from /api/jev/corpus, and one run's scores.
import type { JevCheck } from '../../lib/jev-check';
import type { Level } from '../../lib/jev-presentation';

export interface Para { id: string; path: string; line: number; kind: string; title: string | null; courses: string[]; text: string }
export interface CourseInfo { title: string; live: boolean; paragraphs: number; files: number }
export interface CorpusMeta { title: string; taken: string; commit: string; source: string; kinds: Record<string, number>; courses: Record<string, CourseInfo> }
/** A unit of a run and jev's p(yes), the mean of `samples` (each answer to the same request).
 *  `text` is for display; `words`, when the platform built the run, are all of them (text is cut
 *  at 600 characters), and `answerKey` what jev was shown. */
export interface Scored extends Para { p: number; samples?: number[]; words?: string; answerKey?: string }
export interface Run { check: JevCheck; scored: Scored[]; cached: number; samples?: number; unit?: Level; pres?: string; platform?: boolean; tooLong?: number; leftOut?: number; sample?: string }
export type Colormap = (p: number) => string;
