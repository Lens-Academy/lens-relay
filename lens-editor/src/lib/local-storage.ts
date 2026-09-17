/** localStorage with a fallback: private mode, disabled storage and quota errors all read as "unset". */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // unavailable: the value lasts for this page only
  }
}
