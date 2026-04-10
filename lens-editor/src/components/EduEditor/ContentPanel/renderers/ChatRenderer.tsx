import { TutorInstructions } from '../../TutorInstructions';

interface ChatRendererProps {
  title: string;
  instructions: string;
  onStartEdit: () => void;
}

export function ChatRenderer({ title, instructions, onStartEdit }: ChatRendererProps) {
  return <TutorInstructions title={title} instructions={instructions} onEdit={onStartEdit} />;
}
