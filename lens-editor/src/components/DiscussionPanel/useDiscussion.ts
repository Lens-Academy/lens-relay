import { useState, useEffect } from 'react';
import type * as Y from 'yjs';
import { extractFrontmatter } from '../../lib/frontmatter';
import { parseDiscordUrl } from '../../lib/discord-url';

interface DiscussionInfo {
  channelId: string | null;
  guildId: string | null;
}

const NO_DISCUSSION: DiscussionInfo = { channelId: null, guildId: null };

/**
 * Hook: extracts discussion channel ID from Y.Doc text.
 * Observes the Y.Text 'contents' for frontmatter changes.
 *
 * @param doc - Y.Doc to observe (null = no doc loaded)
 */
export function useDiscussion(doc: Y.Doc | null): DiscussionInfo {
  const [info, setInfo] = useState<DiscussionInfo>(NO_DISCUSSION);

  useEffect(() => {
    if (!doc) {
      setInfo(NO_DISCUSSION);
      return;
    }

    const ytext = doc.getText('contents');

    function parse() {
      const text = ytext.toString();
      const fm = extractFrontmatter(text);
      if (!fm?.discussion || typeof fm.discussion !== 'string') {
        setInfo(NO_DISCUSSION);
        return;
      }

      const parsed = parseDiscordUrl(fm.discussion);
      if (!parsed) {
        setInfo(NO_DISCUSSION);
        return;
      }

      setInfo({ channelId: parsed.channelId, guildId: parsed.guildId });
    }

    // Parse immediately, then observe for changes
    parse();
    ytext.observe(parse);

    return () => {
      ytext.unobserve(parse);
    };
  }, [doc]);

  return info;
}
