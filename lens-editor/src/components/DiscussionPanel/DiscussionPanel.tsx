import type * as Y from 'yjs';
import type { GatewayStatus } from './useMessages';
import { useDiscussion } from './useDiscussion';
import { useMessages } from './useMessages';
import { MessageList } from './MessageList';
import { ComposeBox } from './ComposeBox';

interface DiscussionPanelProps {
  /** Y.Doc to read frontmatter from. Pass null when no doc is loaded. */
  doc: Y.Doc | null;
}

/** Status indicator with colored dot and text label. */
function StatusIndicator({ status }: { status: GatewayStatus }) {
  switch (status) {
    case 'connected':
      return (
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-xs text-green-600">Live</span>
        </span>
      );
    case 'connecting':
    case 'reconnecting':
      return (
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
          <span className="text-xs text-yellow-600">Reconnecting</span>
        </span>
      );
    case 'disconnected':
      return (
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-gray-400" />
          <span className="text-xs text-gray-500">Disconnected</span>
        </span>
      );
  }
}

/**
 * Discussion panel that conditionally renders based on `discussion` frontmatter.
 * Shows Discord channel messages when a discussion URL is present.
 * Returns null when no discussion field exists.
 *
 * In tests, pass doc directly. In production, use ConnectedDiscussionPanel
 * which reads from YDocProvider context.
 */
export function DiscussionPanel({ doc }: DiscussionPanelProps) {
  const { channelId } = useDiscussion(doc);
  const { messages, channelName, loading, error, refetch, reconnect, gatewayStatus, sendMessage } = useMessages(channelId);

  // Don't render anything if no discussion URL in frontmatter
  if (!channelId) return null;

  return (
    <aside
      className="h-full border-l border-gray-200 bg-white flex flex-col"
      role="complementary"
      aria-label="Discussion"
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">
          {channelName ? `#${channelName}` : 'Discussion'}
        </h3>
        <StatusIndicator status={gatewayStatus} />
      </div>

      {/* Disconnected banner (SSE terminated but messages already loaded) */}
      {gatewayStatus === 'disconnected' && error === 'Connection lost' && (
        <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <span className="text-xs text-gray-500">Connection lost</span>
          <button
            onClick={reconnect}
            className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded transition-colors"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Content area */}
      {loading && messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-gray-400">Loading messages...</p>
        </div>
      ) : error && gatewayStatus === 'disconnected' && error !== 'Connection lost' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={reconnect}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded transition-colors"
          >
            Reconnect
          </button>
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={refetch}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <MessageList messages={messages} />
          <ComposeBox channelName={channelName} onSend={sendMessage} />
        </>
      )}
    </aside>
  );
}
