import { useState, useEffect, useRef } from 'react';
import { searchDocuments, type SearchResult } from '../lib/relay-api';

interface UseSearchReturn {
  results: SearchResult[];
  loading: boolean;
  error: string | null;
}

export function useSearch(query: string, debounceMs = 300): UseSearchReturn {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    // Minimum 2 characters to avoid noise
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await searchDocuments(trimmed, 20, controller.signal);
        if (!controller.signal.aborted) {
          // Deduplicate by title+folder, keeping highest-scored entry.
          // Stale Tantivy index entries can produce duplicates with different doc_ids.
          const seen = new Map<string, SearchResult>();
          for (const r of response.results) {
            const key = `${r.title}||${r.folder}`;
            const existing = seen.get(key);
            if (!existing || r.score > existing.score) {
              seen.set(key, r);
            }
          }
          const deduped = Array.from(seen.values()).sort((a, b) => b.score - a.score);
          setResults(deduped);
          setError(null);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Search failed';
          // Handle 503 gracefully (index initializing)
          if (message.includes('503')) {
            setError('Search is initializing...');
          } else {
            setError(message);
          }
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query, debounceMs]);

  return { results, loading, error };
}
