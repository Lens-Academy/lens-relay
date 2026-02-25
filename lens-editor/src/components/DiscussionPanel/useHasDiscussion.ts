import { useYDoc } from '@y-sweet/react';
import { useDiscussion } from './useDiscussion';

/**
 * Returns whether the current document has a discussion field in frontmatter.
 * Must be used inside a RelayProvider (needs Y.Doc context).
 */
export function useHasDiscussion(): boolean {
  const doc = useYDoc();
  const { channelId } = useDiscussion(doc);
  return !!channelId;
}
