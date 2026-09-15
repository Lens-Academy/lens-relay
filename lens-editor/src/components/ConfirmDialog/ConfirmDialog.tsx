import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Extra content between the description and the buttons (e.g. a list). */
  details?: ReactNode;
  onConfirm: () => void;
  confirmLabel?: string;
  /** Disables the confirm button while an action is in flight. */
  busy?: boolean;
  /** When false the dialog stays open after confirm (the caller closes it
   * through `onOpenChange`), so an async action can report back into it. */
  closeOnConfirm?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details,
  onConfirm,
  confirmLabel = 'Delete',
  busy = false,
  closeOnConfirm = true,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/50" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 w-[min(400px,calc(100vw-24px))]">
          <AlertDialog.Title className="text-lg font-semibold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-gray-600 mt-2">
            {description}
          </AlertDialog.Description>
          {details}
          <div className="flex justify-end gap-3 mt-4">
            <AlertDialog.Cancel asChild>
              <button className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200">
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                onClick={(e) => {
                  // Radix closes on Action click unless the event is cancelled.
                  if (!closeOnConfirm) e.preventDefault();
                  onConfirm();
                }}
                disabled={busy}
              >
                {confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
