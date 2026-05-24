import { TutorInstructions } from '../../TutorInstructions';
import type { CommentBadgeInfo } from '../../../../lib/criticmarkup-render';
import type { CriticMarkupRange } from '../../../../lib/criticmarkup-parser';

interface ChatRendererProps {
  title: string;
  instructions: string;
  onStartEdit: () => void;
  enableCriticMarkup?: boolean;
  onClickCriticRange?: (range: CriticMarkupRange) => void;
  onCommentClick?: (absFrom: number) => void;
  commentBadgeMap?: Map<number, CommentBadgeInfo>;
}

export function ChatRenderer({
  title,
  instructions,
  onStartEdit,
  enableCriticMarkup,
  onClickCriticRange,
  onCommentClick,
  commentBadgeMap,
}: ChatRendererProps) {
  return (
    <TutorInstructions
      title={title}
      instructions={instructions}
      onEdit={onStartEdit}
      enableCriticMarkup={enableCriticMarkup}
      onClickCriticRange={onClickCriticRange}
      onCommentClick={onCommentClick}
      commentBadgeMap={commentBadgeMap}
    />
  );
}
