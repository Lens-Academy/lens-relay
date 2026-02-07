// src/lib/criticmarkup-parser.ts
export interface CriticMarkupRange {
  type: 'addition' | 'deletion' | 'substitution' | 'comment' | 'highlight';
  from: number;
  to: number;
  contentFrom: number;  // Where actual content starts (after opening delimiter + metadata)
  contentTo: number;    // Where actual content ends (before closing delimiter)
  content: string;
  oldContent?: string;
  newContent?: string;
  metadata?: {
    author?: string;
    timestamp?: number;
  };
}

interface ParsedContent {
  content: string;
  metadata?: CriticMarkupRange['metadata'];
  metadataLength: number; // Length of metadata + @@ prefix (0 if no metadata)
}

function extractMetadata(rawContent: string): ParsedContent {
  // Check for metadata format: {"author":"..."}@@content
  const metaMatch = rawContent.match(/^(\{[^}]+\})@@(.+)$/s);

  if (!metaMatch) {
    return { content: rawContent, metadataLength: 0 };
  }

  try {
    const metadata = JSON.parse(metaMatch[1]);
    // metadataLength = JSON part + "@@" (2 chars)
    const metadataLength = metaMatch[1].length + 2;
    return {
      content: metaMatch[2],
      metadata: {
        author: metadata.author,
        timestamp: metadata.timestamp,
      },
      metadataLength,
    };
  } catch {
    // Invalid JSON - treat entire content as-is
    return { content: rawContent, metadataLength: 0 };
  }
}

const DELIM_LENGTHS = {
  addition: { open: 3, close: 3 },      // {++ ++}
  deletion: { open: 3, close: 3 },      // {-- --}
  substitution: { open: 3, close: 3 },  // {~~ ~~}
  comment: { open: 3, close: 3 },       // {>> <<}
  highlight: { open: 3, close: 3 },     // {== ==}
};

export function parse(doc: string): CriticMarkupRange[] {
  const ranges: CriticMarkupRange[] = [];

  const patterns: Array<{
    type: CriticMarkupRange['type'];
    regex: RegExp;
    hasSubstitution?: boolean;
  }> = [
    { type: 'addition', regex: /\{\+\+(.*?)\+\+\}/gs },
    { type: 'deletion', regex: /\{--(.*?)--\}/gs },
    { type: 'substitution', regex: /\{~~(.*?)~>(.*?)~~\}/gs, hasSubstitution: true },
    { type: 'comment', regex: /\{>>(.*?)<<\}/gs },
    { type: 'highlight', regex: /\{==(.*?)==\}/gs },
  ];

  for (const { type, regex, hasSubstitution } of patterns) {
    const delims = DELIM_LENGTHS[type];
    let match;
    while ((match = regex.exec(doc)) !== null) {
      const from = match.index;
      const to = match.index + match[0].length;

      let content: string;
      let metadata: CriticMarkupRange['metadata'] | undefined;
      let metadataLength = 0;
      let oldContent: string | undefined;
      let newContent: string | undefined;

      if (hasSubstitution) {
        // For substitution, extract metadata from old part only
        const oldParsed = extractMetadata(match[1]);
        content = `${oldParsed.content}~>${match[2]}`;
        metadata = oldParsed.metadata;
        metadataLength = oldParsed.metadataLength;
        oldContent = oldParsed.content;
        newContent = match[2];
      } else {
        const parsed = extractMetadata(match[1]);
        content = parsed.content;
        metadata = parsed.metadata;
        metadataLength = parsed.metadataLength;
      }

      // contentFrom accounts for opening delimiter + any metadata
      const contentFrom = from + delims.open + metadataLength;
      const contentTo = to - delims.close;

      const range: CriticMarkupRange = {
        type,
        from,
        to,
        contentFrom,
        contentTo,
        content,
      };

      if (metadata) {
        range.metadata = metadata;
      }
      if (oldContent !== undefined) {
        range.oldContent = oldContent;
      }
      if (newContent !== undefined) {
        range.newContent = newContent;
      }

      ranges.push(range);
    }
  }

  // Sort by position
  ranges.sort((a, b) => a.from - b.from);

  return ranges;
}

export interface CommentThread {
  comments: CriticMarkupRange[];
  from: number;
  to: number;
}

export function parseThreads(ranges: CriticMarkupRange[]): CommentThread[] {
  const comments = ranges.filter((r) => r.type === 'comment');

  if (comments.length === 0) {
    return [];
  }

  const threads: CommentThread[] = [];
  let currentThread: CriticMarkupRange[] = [comments[0]];

  for (let i = 1; i < comments.length; i++) {
    const prev = comments[i - 1];
    const curr = comments[i];

    // Adjacent if previous ends exactly where current starts
    if (prev.to === curr.from) {
      currentThread.push(curr);
    } else {
      // Finalize previous thread, start new one
      threads.push({
        comments: currentThread,
        from: currentThread[0].from,
        to: currentThread[currentThread.length - 1].to,
      });
      currentThread = [curr];
    }
  }

  // Don't forget the last thread
  threads.push({
    comments: currentThread,
    from: currentThread[0].from,
    to: currentThread[currentThread.length - 1].to,
  });

  return threads;
}
