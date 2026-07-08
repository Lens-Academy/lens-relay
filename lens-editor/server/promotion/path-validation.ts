import path from 'node:path/posix';
import { PromotionError, type PromotionFileChange } from './types.ts';

const MAX_PROMOTION_PATHS = 100;
const GIT_PATHSPEC_METACHARS = /[*?[]/;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export function validateRepoPath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PromotionError(400, 'Path is required', 'invalid_path');
  }
  if (input.startsWith('/') || input.includes('\\')) {
    throw new PromotionError(400, 'Path must be repository-relative', 'invalid_path');
  }
  rejectControlCharacters(input);
  rejectGitPathspecSyntax(input);

  const segments = input.split('/');
  if (segments.includes('..')) {
    throw new PromotionError(400, 'Path cannot traverse outside the repository', 'invalid_path');
  }

  const normalized = path.normalize(input);
  if (normalized === '.') {
    throw new PromotionError(400, 'Path is required', 'invalid_path');
  }
  rejectControlCharacters(normalized);
  rejectGitPathspecSyntax(normalized);

  return normalized;
}

export function isPromotionPathExcluded(filePath: string): boolean {
  return filePath === '.github' || filePath.startsWith('.github/');
}

export function validatePromotableRepoPath(input: string): string {
  const filePath = validateRepoPath(input);
  if (isPromotionPathExcluded(filePath)) {
    throw new PromotionError(400, 'Path is excluded from production promotion', 'path_not_promotable');
  }
  return filePath;
}

export function validatePromotionPaths(paths: unknown, changedFiles: PromotionFileChange[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new PromotionError(400, 'At least one path is required', 'invalid_paths');
  }
  if (paths.length > MAX_PROMOTION_PATHS) {
    throw new PromotionError(400, `At most ${MAX_PROMOTION_PATHS} paths can be promoted at once`, 'too_many_paths');
  }

  const changedPaths = new Set<string>();
  for (const file of changedFiles) {
    changedPaths.add(file.path);
    if (file.oldPath) changedPaths.add(file.oldPath);
  }

  const selectedPaths = new Set<string>();
  for (const pathValue of paths) {
    if (typeof pathValue !== 'string') {
      throw new PromotionError(400, 'Path must be a string', 'invalid_path');
    }
    selectedPaths.add(validatePromotableRepoPath(pathValue));
  }

  const normalized = [...selectedPaths];
  for (const filePath of normalized) {
    if (!changedPaths.has(filePath)) {
      throw new PromotionError(400, `Path is not changed between staging and main: ${filePath}`, 'path_not_changed');
    }
  }

  return normalized;
}

function rejectControlCharacters(value: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new PromotionError(400, 'Path cannot contain control characters', 'invalid_path');
  }
}

function rejectGitPathspecSyntax(value: string): void {
  if (value.startsWith(':') || GIT_PATHSPEC_METACHARS.test(value)) {
    throw new PromotionError(400, 'Path cannot contain Git pathspec syntax', 'invalid_path');
  }
}
