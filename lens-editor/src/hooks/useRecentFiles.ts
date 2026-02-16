import { useState, useCallback } from 'react';

const STORAGE_KEY = 'lens-recent-files';

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecent(files: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

export function useRecentFiles(maxItems = 20) {
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecent);

  const pushRecent = useCallback((docId: string) => {
    setRecentFiles(prev => {
      const next = [docId, ...prev.filter(id => id !== docId)].slice(0, maxItems);
      saveRecent(next);
      return next;
    });
  }, [maxItems]);

  return { recentFiles, pushRecent };
}
