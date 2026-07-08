import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  createPromotionPr,
  getPromotionChanges,
  getPromotionDiff,
  type PromotionChangesResponse,
  type PromotionDiffResponse,
  type PromotionFileChange,
  type PromotionPrResponse,
} from '../../lib/promotion-api';
import { useNavigation } from '../../contexts/NavigationContext';
import { urlForDoc } from '../../lib/url-utils';
import { RELAY_ID } from '../../lib/constants';
import { editorPathToPromotionPath, promotionPathToEditorPath } from '../../lib/promotion-paths';
import { DiffViewer } from './DiffViewer';

interface PromotionPrResultState {
  response: PromotionPrResponse;
  pathsKey: string;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Promotion request failed';
}

function statusLabel(status: PromotionFileChange['status']) {
  switch (status) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'modified':
      return 'Modified';
    case 'renamed':
      return 'Renamed';
    case 'identical':
      return 'Identical';
  }
}

function togglePath(selected: Set<string>, path: string) {
  const next = new Set(selected);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

export function PromotionPage() {
  const [searchParams] = useSearchParams();
  const { metadata } = useNavigation();
  const queryPath = searchParams.get('path');
  const queryPromotionPath = useMemo(
    () => queryPath ? (editorPathToPromotionPath(queryPath) ?? queryPath) : null,
    [queryPath],
  );
  const [changes, setChanges] = useState<PromotionChangesResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(queryPromotionPath ? [queryPromotionPath] : []));
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<PromotionDiffResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prResult, setPrResult] = useState<PromotionPrResultState | null>(null);
  const diffRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getPromotionChanges()
      .then(response => {
        if (cancelled) return;
        setChanges(response);
        if (queryPromotionPath && response.files.some(file => file.path === queryPromotionPath)) {
          setSelected(previous => new Set([...previous, queryPromotionPath]));
        }
      })
      .catch(loadError => {
        if (cancelled) return;
        setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [queryPromotionPath]);

  const visibleFiles = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const files = changes?.files ?? [];
    if (!needle) return files;
    return files.filter(file => file.path.toLowerCase().includes(needle));
  }, [changes, filter]);

  const visibleRows = useMemo(
    () =>
      visibleFiles.map(file => {
        const editorPath = promotionPathToEditorPath(file.path);
        const meta = metadata?.[editorPath];
        const editorUrl = meta?.id ? urlForDoc(`${RELAY_ID}-${meta.id}`, metadata) : null;
        return { file, editorUrl };
      }),
    [visibleFiles, metadata],
  );

  const selectedPaths = useMemo(() => {
    const files = changes?.files ?? [];
    return files.filter(file => selected.has(file.path)).map(file => file.path);
  }, [changes, selected]);
  const selectedPathsKey = useMemo(() => JSON.stringify(selectedPaths), [selectedPaths]);
  const prMatchesSelection = prResult?.pathsKey === selectedPathsKey;

  const handleToggle = (path: string) => {
    setSelected(current => togglePath(current, path));
    setPrResult(null);
  };

  const handleViewDiff = async (path: string) => {
    const requestId = ++diffRequestRef.current;
    setDiffLoadingPath(path);
    setError(null);
    try {
      const response = await getPromotionDiff(path);
      if (diffRequestRef.current !== requestId) return;
      setDiffResult(response);
    } catch (diffError) {
      if (diffRequestRef.current !== requestId) return;
      setError(errorMessage(diffError));
    } finally {
      if (diffRequestRef.current !== requestId) return;
      setDiffLoadingPath(null);
    }
  };

  const handleCreatePr = async () => {
    if (prMatchesSelection) return;
    const pathsKey = selectedPathsKey;
    setSubmitting(true);
    setError(null);
    setPrResult(null);
    try {
      const response = await createPromotionPr({ paths: selectedPaths });
      setPrResult({ response, pathsKey });
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="h-full overflow-auto bg-gray-50">
      <div className="mx-auto max-w-6xl px-5 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Production promotion</h1>
            <p className="text-sm text-gray-500">Select staging changes to promote to production.</p>
          </div>
          <button
            type="button"
            onClick={handleCreatePr}
            disabled={selectedPaths.length === 0 || submitting || prMatchesSelection}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-300"
          >
            {submitting ? 'Creating PR...' : 'Create promotion PR'}
          </button>
        </div>

        {loading && (
          <div className="rounded-md border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
            Loading production differences...
          </div>
        )}

        {error && (
          <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        {prResult && (
          <section className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
            <h2 className="font-semibold">Pull request created</h2>
            <a
              href={prResult.response.prUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block font-medium underline"
            >
              Pull request #{prResult.response.prNumber}
            </a>
            {prResult.response.branch && (
              <div className="mt-1 font-mono text-xs text-emerald-900">{prResult.response.branch}</div>
            )}
            {prResult.response.autoMergeEnabled ? (
              <p className="mt-2 text-emerald-800">Auto-merge enabled.</p>
            ) : (
              <p className="mt-2 text-amber-800">
                {prResult.response.warning || 'Auto-merge was not enabled.'}
              </p>
            )}
          </section>
        )}

        {!loading && changes && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <label className="min-w-[240px] flex-1 text-sm text-gray-600">
                <span className="sr-only">Filter changed files</span>
                <input
                  type="search"
                  aria-label="Filter changed files"
                  value={filter}
                  onChange={event => setFilter(event.target.value)}
                  placeholder="Filter changed files"
                  className="w-full rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-400"
                />
              </label>
              <div className="text-sm text-gray-500">
                {selectedPaths.length} selected
              </div>
            </div>

            {changes.files.length === 0 ? (
              <div className="rounded-md border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
                No files differ between staging and production.
              </div>
            ) : (
              <>
                {/* Desktop table (md and up) */}
                <div className="hidden overflow-hidden rounded-md border border-gray-200 bg-white md:block">
                  <table className="w-full table-fixed text-left text-sm">
                    <thead className="border-b border-gray-200 bg-gray-100 text-xs uppercase text-gray-500">
                      <tr>
                        <th className="w-10 px-3 py-2">
                          <span className="sr-only">Select file</span>
                        </th>
                        <th className="px-3 py-2">Path</th>
                        <th className="w-24 px-3 py-2">Status</th>
                        <th className="w-28 px-3 py-2">Changes</th>
                        <th className="w-44 px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {visibleRows.map(({ file, editorUrl }) => (
                        <tr key={file.path} className="text-gray-800">
                          <td className="px-3 py-2 align-top">
                            <input
                              type="checkbox"
                              aria-label={`Select ${file.path}`}
                              checked={selected.has(file.path)}
                              onChange={() => handleToggle(file.path)}
                              className="h-4 w-4 rounded border-gray-300"
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="break-all font-mono text-xs">{file.path}</div>
                            {file.oldPath && (
                              <div className="mt-1 break-all text-xs text-gray-500">from {file.oldPath}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-gray-700">{statusLabel(file.status)}</td>
                          <td className="px-3 py-2 align-top font-mono text-xs">
                            <span className="text-emerald-700">+{file.additions}</span>
                            <span className="mx-1 text-gray-300">/</span>
                            <span className="text-red-700">-{file.deletions}</span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => handleViewDiff(file.path)}
                                disabled={diffLoadingPath === file.path}
                                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:text-gray-400"
                              >
                                {diffLoadingPath === file.path ? 'Loading diff...' : 'View diff'}
                              </button>
                              {editorUrl && (
                                <Link
                                  to={editorUrl}
                                  className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                                >
                                  Open in editor
                                </Link>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {visibleRows.length === 0 && (
                    <div className="border-t border-gray-100 px-4 py-6 text-center text-sm text-gray-500">
                      No changed files match this filter.
                    </div>
                  )}
                </div>

                {/* Mobile stacked cards (below md) */}
                <div className="md:hidden">
                  {visibleRows.length === 0 ? (
                    <div className="rounded-md border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
                      No changed files match this filter.
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {visibleRows.map(({ file, editorUrl }) => (
                        <li key={file.path} className="rounded-md border border-gray-200 bg-white p-3">
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${file.path}`}
                              checked={selected.has(file.path)}
                              onChange={() => handleToggle(file.path)}
                              className="mt-0.5 h-5 w-5 shrink-0 rounded border-gray-300"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="break-all font-mono text-xs text-gray-800">{file.path}</div>
                              {file.oldPath && (
                                <div className="mt-1 break-all text-xs text-gray-500">from {file.oldPath}</div>
                              )}
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700">
                                  {statusLabel(file.status)}
                                </span>
                                <span className="font-mono">
                                  <span className="text-emerald-700">+{file.additions}</span>
                                  <span className="mx-1 text-gray-300">/</span>
                                  <span className="text-red-700">-{file.deletions}</span>
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleViewDiff(file.path)}
                              disabled={diffLoadingPath === file.path}
                              className="inline-flex min-h-10 flex-1 items-center justify-center rounded border border-gray-200 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:text-gray-400"
                            >
                              {diffLoadingPath === file.path ? 'Loading diff...' : 'View diff'}
                            </button>
                            {editorUrl && (
                              <Link
                                to={editorUrl}
                                className="inline-flex min-h-10 flex-1 items-center justify-center rounded border border-gray-200 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                Open in editor
                              </Link>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {diffResult && (
              <section className="mt-4">
                <h2 className="mb-2 text-sm font-semibold text-gray-900">Diff: {diffResult.path}</h2>
                <DiffViewer
                  diff={diffResult.diff}
                  isBinary={diffResult.isBinary}
                  beforeBlob={diffResult.beforeBlob}
                  afterBlob={diffResult.afterBlob}
                />
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
