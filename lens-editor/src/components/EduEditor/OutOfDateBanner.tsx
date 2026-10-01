import { Link } from 'react-router-dom';

/** Warns that the Course Editor is unmaintained and can damage course files. */
export function OutOfDateBanner({ fileEditorUrl }: { fileEditorUrl: string }) {
  return (
    <div role="note" className="px-4 py-2.5 bg-amber-50 border-b border-amber-300 text-sm text-amber-900">
      <strong className="font-semibold">The Course Editor is out of date and not in use.</strong>{' '}
      It may not work, and it can break course files. Edit course files{' '}
      <Link to={fileEditorUrl} className="underline font-medium">
        in the File Editor
      </Link>{' '}
      instead.
    </div>
  );
}
