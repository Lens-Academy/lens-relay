import { Component, useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { useYDoc } from '../../lib/ydoc-provider';
import { useSynced } from '../../hooks/useSynced';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAuth } from '../../contexts/AuthContext';
import { findPathByUuid } from '../../lib/uuid-to-path';
import { docUuidFromCompoundId } from '../../lib/url-utils';
import { editorPathToPromotionPath } from '../../lib/promotion-paths';
import { EDU_FOLDER_ID } from '../../lib/constants';
import { countPendingEdits } from '../../lib/criticmarkup-parser';
import {
  fetchContentStatus,
  gitBlobId,
  type CauseCard,
  type ContentIssue,
  type ContentStatusResult,
  type FileStatus,
} from '../../lib/content-status-api';

/** While the platform has not caught up with the text, check often. */
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 30_000;

/**
 * The platform's view of the open file, for files of the Lens Edu folder:
 * whether staging has its latest text, its issues, what a change broke and
 * who made it, the pages that use it, and the check of its pending
 * suggestions. Renders nothing when the server has it switched off
 * (CONTENT_STATUS_ENABLED), for other folders, for files the platform does
 * not build, and until the document has synced: before that the text is
 * empty, and its blob id would read as "not on staging".
 */
export function ContentStatusPanel({ docId, className = '' }: { docId: string; className?: string }) {
  const ydoc = useYDoc();
  const synced = useSynced();
  const { metadata } = useNavigation();
  const { folderUuid, isAllFolders } = useAuth();
  const path = useMemo(() => {
    if (!metadata || (!isAllFolders && folderUuid !== EDU_FOLDER_ID)) return null;
    return editorPathToPromotionPath(findPathByUuid(docUuidFromCompoundId(docId), metadata));
  }, [docId, metadata, folderUuid, isAllFolders]);
  const ytext = useMemo(() => ydoc.getText('contents'), [ydoc]);
  if (!path || !synced) return null;
  return <ContentStatusSection key={path} ytext={ytext} path={path} className={className} />;
}

export function ContentStatusSection({ ytext, path, className = '' }: { ytext: Y.Text; path: string; className?: string }) {
  const result = useContentStatus(ytext, path);
  if (!result || result.kind === 'disabled' || result.kind === 'not_found') return null;
  if (result.kind === 'ok' && !result.status.content) return null;
  return (
    <section aria-label="Content status" className={`p-3 text-sm ${className}`}>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Content status</h3>
      {result.kind === 'error'
        ? <p className="text-gray-500">Status unavailable: {result.message}</p>
        : <GuardedStatusView status={result.status} />}
    </section>
  );
}

type GuardState = { failed: boolean; shown?: FileStatus };

/**
 * The view of one answer, or a note when it cannot be shown: React unmounts
 * the whole tree on a render error that no boundary takes, and one odd
 * answer must not take the editor with it. The next answer is shown again.
 */
class GuardedStatusView extends Component<{ status: FileStatus }, GuardState> {
  state: GuardState = { failed: false };

  static getDerivedStateFromProps({ status }: { status: FileStatus }, { shown }: GuardState) {
    return status === shown ? null : { failed: false, shown: status };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? <p className="text-gray-500">Status unavailable: the panel could not show this answer.</p>
      : <ContentStatusView status={this.props.status} />;
  }
}

/**
 * Ask for the file's status, with the Git blob id of the live text, again
 * every FAST_POLL_MS while the platform is behind that text and every
 * SLOW_POLL_MS otherwise. An edit makes the last answer stale, so it brings
 * the next check forward. In a hidden tab a check that falls due waits until
 * the tab is shown again, and no check is made before the time a busy
 * platform asked for (Retry-After).
 */
function useContentStatus(ytext: Y.Text, path: string): ContentStatusResult | null {
  const [result, setResult] = useState<ContentStatusResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextAt = 0;
    let quietUntil = 0;
    let edited = false;
    let paused = false;
    const controller = new AbortController();

    const schedule = (delay: number) => {
      clearTimeout(timer);
      nextAt = Date.now() + delay;
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      timer = undefined;
      if (Date.now() < quietUntil) {
        schedule(quietUntil - Date.now());
        return;
      }
      if (document.hidden) {
        paused = true;
        return;
      }
      edited = false;
      const text = ytext.toString();
      const blob = await gitBlobId(text);
      if (cancelled) return;
      if (!blob) {
        setResult({ kind: 'disabled' });
        return;
      }
      const next = await fetchContentStatus(path, blob, countPendingEdits(text) > 0, controller.signal);
      if (cancelled) return;
      setResult(next);
      if (next.kind === 'disabled' || (next.kind === 'ok' && !next.status.content)) return;
      if (next.kind === 'error' && next.retryAfterMs) quietUntil = Date.now() + next.retryAfterMs;
      const state = next.kind === 'ok' ? next.status.published?.state : undefined;
      schedule(edited || state === 'behind' || state === 'pending' ? FAST_POLL_MS : SLOW_POLL_MS);
    };

    const onEdit = () => {
      edited = true;
      if (timer !== undefined && nextAt - Date.now() > FAST_POLL_MS) schedule(FAST_POLL_MS);
    };

    const onVisibilityChange = () => {
      if (!paused || document.hidden) return;
      paused = false;
      void poll();
    };

    ytext.observe(onEdit);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      ytext.unobserve(onEdit);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [ytext, path]);

  return result;
}

export function ContentStatusView({ status }: { status: FileStatus }) {
  const { issues, used_by: usedBy } = status;
  const { broken_by: brokenBy, caused_here: causedHere } = status.cause_cards;
  return (
    <div className="space-y-3">
      <PublishedLine status={status} />

      <div>
        {issues.length === 0
          ? <p className="text-gray-500">No issues in this file.</p>
          : <IssueList title={`Issues in this file (${issues.length})`} issues={issues} />}
      </div>

      {brokenBy.length > 0 && (
        <CardList title="Broken by a change" cards={brokenBy} />
      )}
      {causedHere.length > 0 && (
        <CardList title="Problems a change to this file caused" cards={causedHere} />
      )}

      {usedBy.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-600 mb-1">Used by {plural(usedBy.length, 'page')}</h4>
          <ul className="space-y-0.5">
            {usedBy.map(page => (
              <li key={page.page} className="text-gray-700">
                {page.title || page.page}
                <span className="text-xs text-gray-400">
                  {page.reads === 'text' ? ' · uses its text' : ' · uses facts about it only'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.drafts && (
        <div>
          <h4 className="text-xs font-medium text-gray-600 mb-1">
            {plural(status.drafts.pending, 'pending suggestion')}: if all are accepted
          </h4>
          {status.drafts.issues.length === 0 && status.drafts.new_elsewhere.length === 0
            ? <p className="text-gray-500">No issues.</p>
            : (
              <>
                {status.drafts.issues.length > 0 && <IssueList title="In this file" issues={status.drafts.issues} />}
                {status.drafts.new_elsewhere.length > 0 && (
                  <IssueList title="New in other files" issues={status.drafts.new_elsewhere} showFile />
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
}

// The editor's server asks the platform that LENS_PLATFORM_URL names, which
// is staging. Learners use production, which changes when a file is promoted.
const STATE_TEXT = {
  published: { label: 'On staging', dot: 'bg-green-500', detail: 'Staging has this text. Production gets it when the file is promoted.' },
  pending: { label: 'Staging is updating', dot: 'bg-amber-400', detail: 'Staging is processing a newer commit.' },
  behind: { label: 'Not on staging yet', dot: 'bg-gray-400', detail: 'The latest changes are not in a commit yet. The relay sync sends them to staging.' },
  missing: { label: 'Not on staging yet', dot: 'bg-gray-400', detail: 'Staging does not have this file yet.' },
} as const;

function PublishedLine({ status }: { status: FileStatus }) {
  const state = status.published?.state;
  if (!state) return null;
  const text = STATE_TEXT[state];
  const processed = status.processed;
  return (
    <div>
      <p className="flex items-center gap-1.5 font-medium text-gray-800">
        <span className={`inline-block h-2 w-2 rounded-full ${text.dot}`} aria-hidden />
        {text.label}
      </p>
      <p className="text-xs text-gray-500">
        {text.detail}
        {processed && ` Commit ${processed.commit.slice(0, 7)}, processed ${ago(processed.processed_at)}.`}
      </p>
    </div>
  );
}

function IssueList({ title, issues, showFile = false }: { title: string; issues: ContentIssue[]; showFile?: boolean }) {
  return (
    <div>
      <h4 className="text-xs font-medium text-gray-600 mb-1">{title}</h4>
      <ul className="space-y-1">
        {issues.map((issue, i) => (
          <li key={`${issue.file}:${issue.line ?? ''}:${i}`} className="text-gray-700">
            <span className={issue.severity === 'error' ? 'text-red-700 font-medium' : 'text-amber-700 font-medium'}>
              {issue.severity === 'error' ? 'Error' : 'Warning'}
            </span>
            {issue.category === 'wip' && <span className="text-xs text-gray-400"> (wip)</span>}
            <span className="text-xs text-gray-500">
              {' '}{showFile ? issue.file : ''}{issue.line !== undefined ? `${showFile ? ':' : 'line '}${issue.line}` : ''}
            </span>
            <span>: {issue.message}</span>
            {issue.suggestion && <span className="block text-xs text-gray-500">Fix: {issue.suggestion}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardList({ title, cards }: { title: string; cards: CauseCard[] }) {
  return (
    <div>
      <h4 className="text-xs font-medium text-gray-600 mb-1">{title}</h4>
      <ul className="space-y-2">
        {cards.map(card => <CauseCardView key={card.id} card={card} />)}
      </ul>
    </div>
  );
}

/**
 * What broke, which change, what changed, who, and how sure: in that order.
 * Who and how sure are the platform's own sentences; a card without them
 * says nothing about either.
 */
export function CauseCardView({ card }: { card: CauseCard }) {
  const lost = card.lost_content ?? [];
  const changes = card.changes ?? [];
  return (
    <li className="rounded border border-gray-200 bg-white p-2">
      <p className="text-gray-800">{card.what_broke}</p>
      {lost.length > 0 && (
        <p className="text-xs text-gray-600">
          Missing from {plural(lost.length, 'page')}: {lost.map(l => l.title || l.page).join(', ')}.
        </p>
      )}
      {changes.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
          {changes.map(change => (
            <li key={change.file}>
              <span className="font-mono">{change.file}</span>: {change.summary}
            </li>
          ))}
        </ul>
      )}
      {card.who_text && <p className="mt-1 text-xs text-gray-600">{card.who_text}</p>}
      <p className="text-xs text-gray-500">
        {card.certainty_text && `${card.certainty_text} `}Since {ago(card.created_at)}.
      </p>
    </li>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "3 s ago", "4 min ago", "2 h ago", "3 d ago". */
function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return 'at an unknown time';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}
