import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  createPromotionPr,
  getPromotionDiff,
  type PromotionDiffResponse,
  type PromotionPrResponse,
  type PromotionStatusResponse,
} from '../../lib/promotion-api';
import { promotionStatusLabel } from './PromotionStatus';

interface PromoteFileDialogProps {
  open: boolean;
  filePath: string;
  status: PromotionStatusResponse | null;
  onClose: () => void;
  onPromoted?: () => void;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Promotion request failed';
}

function diffContent(diff: PromotionDiffResponse) {
  if (diff.isBinary) return 'Binary file: text diff is not available.';
  return diff.diff.trim() ? diff.diff : 'No text diff is available.';
}

export function PromoteFileDialog({
  open,
  filePath,
  status,
  onClose,
  onPromoted,
}: PromoteFileDialogProps) {
  const [diff, setDiff] = useState<{ filePath: string; response: PromotionDiffResponse } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ filePath: string; response: PromotionPrResponse } | null>(null);
  const lifecycleRef = useRef(0);
  const activeKeyRef = useRef('');
  const diffRequestRef = useRef(0);
  const promoteRequestRef = useRef(0);
  const activeKey = `${open ? 'open' : 'closed'}:${filePath}`;

  if (activeKeyRef.current !== activeKey) {
    activeKeyRef.current = activeKey;
    lifecycleRef.current += 1;
  }

  useEffect(() => {
    setDiff(null);
    setDiffLoading(false);
    setDiffError(null);
    setSubmitting(false);
    setSubmitError(null);
    setResult(null);
  }, [open, filePath]);

  const handleViewDiff = async () => {
    const lifecycleId = lifecycleRef.current;
    const requestId = ++diffRequestRef.current;
    const requestFilePath = filePath;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const response = await getPromotionDiff(requestFilePath);
      if (lifecycleRef.current !== lifecycleId || diffRequestRef.current !== requestId) return;
      setDiff({ filePath: requestFilePath, response });
    } catch (error) {
      if (lifecycleRef.current !== lifecycleId || diffRequestRef.current !== requestId) return;
      setDiffError(errorMessage(error));
    } finally {
      if (lifecycleRef.current !== lifecycleId || diffRequestRef.current !== requestId) return;
      setDiffLoading(false);
    }
  };

  const handlePromote = async () => {
    const lifecycleId = lifecycleRef.current;
    const requestId = ++promoteRequestRef.current;
    const requestFilePath = filePath;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await createPromotionPr({ paths: [requestFilePath] });
      if (lifecycleRef.current !== lifecycleId || promoteRequestRef.current !== requestId) return;
      setResult({ filePath: requestFilePath, response });
      onPromoted?.();
    } catch (error) {
      if (lifecycleRef.current !== lifecycleId || promoteRequestRef.current !== requestId) return;
      setSubmitError(errorMessage(error));
    } finally {
      if (lifecycleRef.current !== lifecycleId || promoteRequestRef.current !== requestId) return;
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[82vh] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-white shadow-xl">
          <div className="border-b border-gray-200 px-5 py-4">
            <Dialog.Title className="text-base font-semibold text-gray-900">
              Promote file to production
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-600">
              Create a production promotion pull request for this file.
            </Dialog.Description>
          </div>

          <div className="max-h-[calc(82vh-142px)] overflow-y-auto px-5 py-4">
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-gray-500">File</dt>
              <dd className="break-all font-mono text-xs text-gray-800">{filePath}</dd>
              <dt className="text-gray-500">Status</dt>
              <dd className="text-gray-800">{promotionStatusLabel(status)}</dd>
              <dt className="text-gray-500">Changes</dt>
              <dd className="text-gray-800">
                +{status?.additions ?? 0} / -{status?.deletions ?? 0}
              </dd>
            </dl>

            <div className="mt-4">
              <button
                type="button"
                onClick={handleViewDiff}
                disabled={diffLoading}
                className="rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:text-gray-400"
              >
                {diffLoading ? 'Loading diff...' : 'View diff'}
              </button>
              {diffError && (
                <p className="mt-2 text-sm text-red-600" role="alert">
                  {diffError}
                </p>
              )}
              {diff && diff.filePath === filePath && (
                <pre className="mt-3 max-h-72 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-5 text-gray-800">
                  {diffContent(diff.response)}
                </pre>
              )}
            </div>

            {submitError && (
              <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {submitError}
              </p>
            )}

            {result && result.filePath === filePath && (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <a
                  href={result.response.prUrl}
                  className="font-medium underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Pull request #{result.response.prNumber}
                </a>
                <div className="mt-1 font-mono text-xs">{result.response.branch}</div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
              >
                Close
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handlePromote}
              disabled={submitting || result?.filePath === filePath}
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-300"
            >
              {submitting ? 'Promoting...' : 'Promote file'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
