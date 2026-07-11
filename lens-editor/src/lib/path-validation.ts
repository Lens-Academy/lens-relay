const DOUBLE_QUOTE_ERROR = 'File names cannot contain double quotes';

/** Reject paths containing double quotes, which are invalid in Windows filenames. */
export function validateFilePath(path: string): void {
  if (path.includes('"')) {
    throw new Error(DOUBLE_QUOTE_ERROR);
  }
}
