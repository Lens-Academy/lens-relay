import type * as Y from 'yjs';
import { parseComments, type CommentCluster } from './comment-store';

interface OrphanedCommentsPanelProps {
  ytext: Y.Text;
  orphanedIds: string[];
  onJumpToSource: (id: string) => void;
}

export function OrphanedCommentsPanel({ ytext, orphanedIds, onJumpToSource }: OrphanedCommentsPanelProps) {
  if (orphanedIds.length === 0) return null;

  const clusters = parseComments(ytext.toString());
  const clustersById = new Map(clusters.map(cluster => [cluster.comment.id, cluster]));
  const orphans = orphanedIds.flatMap((id): CommentCluster[] => {
    const cluster = clustersById.get(id);
    return cluster ? [cluster] : [];
  });

  if (orphans.length === 0) return null;

  return (
    <aside className="w-72 border-l border-gray-200 bg-gray-50 p-3">
      <h3 className="text-xs font-medium text-gray-700">Orphaned comments ({orphans.length})</h3>
      <ul className="mt-2 space-y-2">
        {orphans.map(orphan => (
          <li key={orphan.comment.id} className="rounded border border-gray-200 bg-white p-2 text-sm">
            <div className="text-xs text-gray-500">{orphan.comment.author}</div>
            <div className="mt-1 text-gray-900">{orphan.comment.body}</div>
            <button
              type="button"
              className="mt-2 text-xs font-medium text-blue-600 hover:underline"
              onClick={() => onJumpToSource(orphan.comment.id)}
            >
              Find in source
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
