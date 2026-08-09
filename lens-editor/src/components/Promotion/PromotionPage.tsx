import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  createPromotionPr,
  getPromotionChanges,
  getPromotionDiff,
  type PromotionChangesResponse,
  type PromotionCurriculumIndex,
  type PromotionDiffResponse,
  type PromotionFileChange,
  type PromotionPrResponse,
} from '../../lib/promotion-api';
import { useNavigation } from '../../contexts/NavigationContext';
import { urlForDoc } from '../../lib/url-utils';
import { RELAY_ID } from '../../lib/constants';
import { editorPathToPromotionPath, promotionPathToEditorPath } from '../../lib/promotion-paths';
import { DiffViewer } from './DiffViewer';

const MAX_PROMOTION_PATHS = 1000;
const EMPTY_CURRICULUM: PromotionCurriculumIndex = { courses: [], modules: [], memberships: {} };
type SelectionFilter = 'all' | 'selected' | 'unselected';

interface FilterOption {
  id: string;
  label: string;
  count: number;
}

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

function intersects(values: string[] | undefined, selected: Set<string>): boolean {
  return !!values?.some(value => selected.has(value));
}

function folderForPath(filePath: string): string {
  const slash = filePath.indexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

function MultiSelectFilter({ label, emptyLabel, options, selected, onToggle }: {
  label: string;
  emptyLabel?: string;
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const matching = options.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedLabels = options.filter(option => selected.has(option.id)).map(option => option.label);
  const summary = selectedLabels.length === 0
    ? (emptyLabel ?? `All ${label.toLowerCase()}s`)
    : selectedLabels.length === 1
      ? selectedLabels[0]
      : `${selectedLabels.length} ${label.toLowerCase()}s`;

  return (
    <details className="group relative">
      <summary className={`flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors marker:content-none [&::-webkit-details-marker]:hidden ${
        selected.size > 0
          ? 'border-sky-300 bg-sky-50 text-sky-900'
          : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
      }`}>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">{label}</span>
        <span className="max-w-48 truncate font-medium">{summary}</span>
        <span className="ml-auto text-[10px] text-gray-400 transition-transform group-open:rotate-180">▼</span>
      </summary>
      <div className="absolute left-0 z-30 mt-1 w-80 max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl shadow-gray-900/10">
        <div className="border-b border-gray-100 p-2">
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={`Search ${label.toLowerCase()}s`}
            placeholder={`Search ${label.toLowerCase()}s`}
            className="w-full rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm outline-none focus:border-sky-400 focus:bg-white"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1.5">
          {matching.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-gray-400">No matching {label.toLowerCase()}s</p>
          ) : matching.map(option => (
            <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-gray-50">
              <input
                type="checkbox"
                checked={selected.has(option.id)}
                onChange={() => onToggle(option.id)}
                className="h-4 w-4 rounded border-gray-300 text-sky-600"
              />
              <span className="min-w-0 flex-1 truncate text-gray-700">{option.label}</span>
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] tabular-nums text-gray-500">{option.count}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
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
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  const [courseFilter, setCourseFilter] = useState<Set<string>>(new Set());
  const [moduleFilter, setModuleFilter] = useState<Set<string>>(new Set());
  const [selectionFilter, setSelectionFilter] = useState<SelectionFilter>('all');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<PromotionDiffResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prResult, setPrResult] = useState<PromotionPrResultState | null>(null);
  const diffRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getPromotionChanges()
      .then(response => {
        if (cancelled) return;
        setChanges(response);
        const available = new Set(response.files.map(file => file.path));
        setSelected(previous => {
          const next = new Set([...previous].filter(filePath => available.has(filePath)));
          if (queryPromotionPath && available.has(queryPromotionPath)) next.add(queryPromotionPath);
          return next;
        });
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

  const curriculum = changes?.curriculum ?? EMPTY_CURRICULUM;
  const baseMatches = useCallback((file: PromotionFileChange, includeSelection = true) => {
    const needle = filter.trim().toLowerCase();
    if (needle && !file.path.toLowerCase().includes(needle) && !file.oldPath?.toLowerCase().includes(needle)) return false;
    if (folderFilter.size > 0 && !folderFilter.has(folderForPath(file.path))) return false;
    if (includeSelection && selectionFilter === 'selected' && !selected.has(file.path)) return false;
    if (includeSelection && selectionFilter === 'unselected' && selected.has(file.path)) return false;
    return true;
  }, [filter, folderFilter, selectionFilter, selected]);

  const visibleFiles = useMemo(() => {
    const files = changes?.files ?? [];
    return files.filter(file => {
      if (!baseMatches(file)) return false;
      const membership = curriculum.memberships[file.path];
      if (courseFilter.size > 0 && !intersects(membership?.coursePaths, courseFilter)) return false;
      if (courseFilter.size > 0 && moduleFilter.size > 0 && !intersects(membership?.modulePaths, moduleFilter)) return false;
      return true;
    });
  }, [changes, courseFilter, moduleFilter, curriculum, baseMatches]);

  const folderOptions = useMemo<FilterOption[]>(() => {
    const folders = new Set((changes?.files ?? []).map(file => folderForPath(file.path)));
    return [...folders].map(folder => ({
      id: folder,
      label: folder || 'Root files',
      count: (changes?.files ?? []).filter(file => folderForPath(file.path) === folder).length,
    })).sort((a, b) => a.label.localeCompare(b.label));
  }, [changes]);

  const courseOptions = useMemo<FilterOption[]>(() => curriculum.courses.map(course => ({
    id: course.path,
    label: course.label,
    count: (changes?.files ?? []).filter(file => baseMatches(file) && curriculum.memberships[file.path]?.coursePaths.includes(course.path)).length,
  })), [changes, curriculum, baseMatches]);

  const availableModules = useMemo(() => curriculum.modules.filter(module => (
    intersects(module.coursePaths, courseFilter) || moduleFilter.has(module.path)
  )), [curriculum, courseFilter, moduleFilter]);
  const moduleOptions = useMemo<FilterOption[]>(() => availableModules.map(module => ({
    id: module.path,
    label: module.label,
    count: (changes?.files ?? []).filter(file => {
      if (!baseMatches(file)) return false;
      const membership = curriculum.memberships[file.path];
      return intersects(membership?.coursePaths, courseFilter) && membership?.modulePaths.includes(module.path);
    }).length,
  })), [availableModules, changes, curriculum, courseFilter, baseMatches]);

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
  const selectedVisibleCount = visibleFiles.filter(file => selected.has(file.path)).length;
  const addablePaths = visibleFiles.filter(file => !selected.has(file.path)).map(file => file.path);
  const removablePaths = visibleFiles.filter(file => selected.has(file.path)).map(file => file.path);
  const filtersActive = filter.trim() !== '' || folderFilter.size > 0 || courseFilter.size > 0
    || moduleFilter.size > 0 || selectionFilter !== 'all';

  const handleToggle = (path: string) => {
    if (!selected.has(path) && selectedPaths.length >= MAX_PROMOTION_PATHS) {
      setSelectionError(`A promotion can include at most ${MAX_PROMOTION_PATHS} files. Remove a file before adding another.`);
      return;
    }
    setSelected(current => togglePath(current, path));
    setSelectionError(null);
    setPrResult(null);
  };

  const handleAddFiltered = () => {
    if (selectedPaths.length + addablePaths.length > MAX_PROMOTION_PATHS) {
      const overflow = selectedPaths.length + addablePaths.length - MAX_PROMOTION_PATHS;
      setSelectionError(`That would exceed the ${MAX_PROMOTION_PATHS}-file limit by ${overflow}. Narrow the filters or remove selected files first.`);
      return;
    }
    setSelected(current => new Set([...current, ...addablePaths]));
    setSelectionError(null);
    setPrResult(null);
  };

  const handleRemoveFiltered = () => {
    setSelected(current => {
      const next = new Set(current);
      removablePaths.forEach(path => next.delete(path));
      return next;
    });
    setSelectionError(null);
    setPrResult(null);
  };

  const handleClearSelection = () => {
    setSelected(new Set());
    setSelectionError(null);
    setPrResult(null);
  };

  const toggleFilterValue = (setter: Dispatch<SetStateAction<Set<string>>>, value: string) => {
    setter(current => togglePath(current, value));
  };

  const toggleCourse = (value: string) => {
    if (courseFilter.size === 1 && courseFilter.has(value)) setModuleFilter(new Set());
    setCourseFilter(current => togglePath(current, value));
  };

  const clearFilters = () => {
    setFilter('');
    setFolderFilter(new Set());
    setCourseFilter(new Set());
    setModuleFilter(new Set());
    setSelectionFilter('all');
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
      if (diffRequestRef.current === requestId) setDiffLoadingPath(null);
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
            {changes.files.length > 0 && (
              <section className="mb-4 overflow-visible rounded-xl border border-gray-200 bg-white shadow-sm shadow-gray-900/[0.03]" aria-label="Promotion filters">
                <div className="flex flex-col gap-3 border-b border-gray-100 p-3 md:p-4">
                  <div className="flex flex-col gap-2 md:flex-row">
                    <label className="relative min-w-[240px] flex-1 text-sm text-gray-600">
                      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400" aria-hidden="true">⌕</span>
                      <input
                        type="search"
                        aria-label="Filter changed files"
                        value={filter}
                        onChange={event => setFilter(event.target.value)}
                        placeholder="Find a changed file or previous path"
                        className="h-9 w-full rounded-md border border-gray-200 bg-gray-50 pl-8 pr-3 text-sm text-gray-800 outline-none transition-colors focus:border-sky-400 focus:bg-white"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <MultiSelectFilter
                        label="Folder"
                        options={folderOptions}
                        selected={folderFilter}
                        onToggle={value => toggleFilterValue(setFolderFilter, value)}
                      />
                      {courseOptions.length > 0 && (
                        <MultiSelectFilter
                          label="Course"
                          options={courseOptions}
                          selected={courseFilter}
                          onToggle={toggleCourse}
                        />
                      )}
                    </div>
                  </div>

                  {courseFilter.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-100 bg-sky-50/60 p-2">
                      <span className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-sky-700">Module scope</span>
                      <button
                        type="button"
                        onClick={() => setModuleFilter(new Set())}
                        aria-pressed={moduleFilter.size === 0}
                        className={`min-h-8 rounded-md px-2.5 text-xs font-medium transition-colors ${moduleFilter.size === 0 ? 'bg-sky-700 text-white shadow-sm' : 'bg-white text-gray-600 hover:bg-sky-100'}`}
                      >
                        All modules
                      </button>
                      <MultiSelectFilter
                        label="Module"
                        emptyLabel="Choose modules"
                        options={moduleOptions}
                        selected={moduleFilter}
                        onToggle={value => toggleFilterValue(setModuleFilter, value)}
                      />
                      <span className="text-xs text-sky-800/70">
                        {moduleFilter.size === 0 ? 'Including every module in the selected courses' : `${moduleFilter.size} specific module${moduleFilter.size === 1 ? '' : 's'}`}
                      </span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-gray-500">Out of filtered files, show:</span>
                    <div
                      role="group"
                      aria-label="Files to show"
                      className="inline-flex rounded-full border border-gray-200 bg-gray-100 p-0.5 shadow-inner shadow-gray-200/60"
                    >
                      {(['all', 'selected', 'unselected'] as const).map(value => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setSelectionFilter(value)}
                          aria-pressed={selectionFilter === value}
                          className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-[background-color,color,box-shadow] ${
                            selectionFilter === value
                              ? 'bg-gray-800 text-white shadow-sm'
                              : 'text-gray-500 hover:bg-white/70 hover:text-gray-700'
                          }`}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    {filtersActive && (
                      <button type="button" onClick={clearFilters} className="ml-auto text-xs font-medium text-sky-700 hover:text-sky-900">
                        Clear filters
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-3 bg-gray-50/70 p-3 md:flex-row md:items-center md:justify-between md:px-4">
                  <div>
                    <p className="text-sm font-medium tabular-nums text-gray-800">
                      {visibleFiles.length} of {changes.files.length} changed files
                      <span className="mx-1.5 text-gray-300">·</span>
                      {selectedPaths.length} selected
                      <span className="mx-1.5 text-gray-300">·</span>
                      {selectedVisibleCount} selected in results
                    </p>
                    <p className="mt-0.5 text-xs text-gray-400">Maximum {MAX_PROMOTION_PATHS} files per promotion</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleAddFiltered}
                      disabled={addablePaths.length === 0}
                      className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
                    >
                      Add {addablePaths.length} filtered file{addablePaths.length === 1 ? '' : 's'} to selection
                    </button>
                    <button
                      type="button"
                      onClick={handleRemoveFiltered}
                      disabled={removablePaths.length === 0}
                      className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
                    >
                      Remove {removablePaths.length} filtered file{removablePaths.length === 1 ? '' : 's'} from selection
                    </button>
                    <button
                      type="button"
                      onClick={handleClearSelection}
                      disabled={selectedPaths.length === 0}
                      className="rounded-md px-2 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:text-gray-300"
                    >
                      Clear selection
                    </button>
                  </div>
                </div>
              </section>
            )}

            {selectionError && (
              <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
                {selectionError}
              </p>
            )}

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
                      <p>No changed files match the current filters.</p>
                      <button type="button" onClick={clearFilters} className="mt-2 font-medium text-sky-700 hover:text-sky-900">Clear filters</button>
                    </div>
                  )}
                </div>

                {/* Mobile stacked cards (below md) */}
                <div className="md:hidden">
                  {visibleRows.length === 0 ? (
                    <div className="rounded-md border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
                      <p>No changed files match the current filters.</p>
                      <button type="button" onClick={clearFilters} className="mt-2 font-medium text-sky-700 hover:text-sky-900">Clear filters</button>
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
