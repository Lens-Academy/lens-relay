import { useState, useEffect, useCallback } from 'react';

export interface SuggestionItem {
  type: 'addition' | 'deletion' | 'substitution';
  content: string;
  old_content: string | null;
  new_content: string | null;
  author: string | null;
  timestamp: number | null;
  from: number;
  to: number;
  raw_markup: string;
  context_before: string;
  context_after: string;
  line: number;
}

export interface FileSuggestions {
  path: string;
  doc_id: string;
  folder_id: string;
  suggestions: SuggestionItem[];
}

export interface SuggestionsResponse {
  files: FileSuggestions[];
}

export function useSuggestions(folderIds: string[]) {
  const [data, setData] = useState<FileSuggestions[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const headers: Record<string, string> = {};
    const token = localStorage.getItem('lens-share-token');
    if (token) headers['X-Share-Token'] = token;

    const results = await Promise.all(
      folderIds.map(async (folderId): Promise<FileSuggestions[] | null> => {
        try {
          const res = await fetch(`/api/relay/suggestions?folder_id=${encodeURIComponent(folderId)}`, {
            headers,
            // Bound the wait: a hung relay must surface as an error, not an
            // infinite spinner (2026-07-02 prod incident)
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) return null;
          const json: SuggestionsResponse = await res.json();
          return json.files.map(f => ({ ...f, folder_id: folderId }));
        } catch {
          return null;
        }
      }),
    );

    const allFiles = results.filter((r): r is FileSuggestions[] => r !== null).flat();
    const failed = results.filter(r => r === null).length;
    setData(allFiles);
    setError(
      failed > 0 && allFiles.length === 0
        ? `Failed to fetch suggestions for ${failed} folder${failed !== 1 ? 's' : ''}`
        : null,
    );
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderIds.join(',')]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
