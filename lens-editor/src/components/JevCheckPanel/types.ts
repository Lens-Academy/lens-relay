// The workbench's data: corpus rows from /api/jev/corpus, and one run's scores.
import type { JevCheck } from '../../lib/jev-check';
import type { Level } from '../../lib/jev-present';

export interface Para { id: string; path: string; line: number; kind: string; title: string | null; courses: string[]; text: string }
export interface CourseInfo { title: string; live: boolean; paragraphs: number; files: number }
export interface CorpusMeta { title: string; taken: string; commit: string; source: string; kinds: Record<string, number>; courses: Record<string, CourseInfo> }
export interface Scored extends Para { p: number }
export interface Run { check: JevCheck; scored: Scored[]; cached: number; unit?: Level; pres?: string; platform?: boolean; tooLong?: number }
export type Colormap = (p: number) => string;
