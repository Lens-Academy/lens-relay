import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  startCompletion,
  currentCompletions,
  completionStatus,
} from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { createWikilinkCompletionSource, matchLabel, normalizeForSearch, wikilinkAutocomplete } from './wikilinkAutocomplete';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';

const testMetadata: FolderMetadata = {
  '/Notes.md': { id: 'doc-notes', type: 'markdown', version: 0 },
  '/Tasks.md': { id: 'doc-tasks', type: 'markdown', version: 0 },
  '/Projects/README.md': { id: 'doc-proj', type: 'markdown', version: 0 },
  '/attachments/image.png': { id: 'img-1', type: 'image', version: 0 },
};

/**
 * Helper to get completions at a position by invoking the real completion source.
 * Creates real EditorState and CompletionContext, then calls the source function.
 */
function getCompletions(content: string, pos: number, metadata: FolderMetadata | null, currentFilePath?: string) {
  const state = EditorState.create({
    doc: content,
    selection: { anchor: pos },
    extensions: [markdown()],
  });
  const context = new CompletionContext(state, pos, false);
  const source = createWikilinkCompletionSource(() => metadata, () => currentFilePath ?? null);
  return source(context);
}

describe('wikilinkAutocomplete', () => {
  it('returns null when not in wikilink context', () => {
    const result = getCompletions('regular text', 5, testMetadata);
    expect(result).toBeNull();
  });

  it('returns null for single bracket (markdown links)', () => {
    // Markdown link syntax [text](url) should NOT trigger wikilink autocomplete
    const result = getCompletions('See [link', 9, testMetadata);
    expect(result).toBeNull();
  });

  it('returns completions when typing after [[', () => {
    const result = getCompletions('See [[', 6, testMetadata);

    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
  });

  it('filters options based on typed query', () => {
    // Type "Not" after [[ to filter to "Notes"
    const result = getCompletions('See [[Not', 9, testMetadata);

    expect(result).not.toBeNull();
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('Notes');
    expect(labels).not.toContain('Tasks');
  });

  it('only suggests markdown files, not images', () => {
    const result = getCompletions('Link [[', 7, testMetadata);

    expect(result).not.toBeNull();
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('Notes');
    expect(labels).toContain('Tasks');
    expect(labels).toContain('Projects/README');
    // Image should not appear
    expect(labels.every(l => l !== 'image')).toBe(true);
  });

  it('includes closing brackets in apply when not already present', () => {
    // No ]] after cursor position
    const result = getCompletions('See [[No', 8, testMetadata);

    expect(result).not.toBeNull();
    const notesOption = result!.options.find(o => o.label === 'Notes');
    expect(notesOption).toBeDefined();
    // apply should include ]] since none exists after cursor
    expect(notesOption!.apply).toBe('Notes]]');
  });

  it('uses apply function to move cursor past ]] when already present', () => {
    // ]] exists after cursor (from closeBrackets auto-completing [[ -> [[]])
    const result = getCompletions('See [[No]]', 8, testMetadata);

    expect(result).not.toBeNull();
    const notesOption = result!.options.find(o => o.label === 'Notes');
    expect(notesOption).toBeDefined();
    // apply should be a function that replaces through ]] and positions cursor after
    expect(typeof notesOption!.apply).toBe('function');
  });

  it('boosts prefix matches over substring matches', () => {
    // Design test data where substring match comes BEFORE prefix match alphabetically
    // Query: "note"
    // - "Anote" contains "note" (substring), alphabetically first
    // - "Notebook" starts with "note" (prefix), alphabetically second
    // Without boost: Anote would be first (alphabetical)
    // With boost: Notebook should be first (prefix match boosted)
    const boostTestMetadata: FolderMetadata = {
      '/Anote.md': { id: 'doc-anote', type: 'markdown', version: 0 },      // substring match, alpha first
      '/Notebook.md': { id: 'doc-notebook', type: 'markdown', version: 0 }, // prefix match, alpha second
      '/Denote.md': { id: 'doc-denote', type: 'markdown', version: 0 },     // substring match
    };

    const result = getCompletions('See [[note', 10, boostTestMetadata);

    expect(result).not.toBeNull();
    const labels = result!.options.map(o => o.label);
    // All three match "note"
    expect(labels).toContain('Anote');
    expect(labels).toContain('Notebook');
    expect(labels).toContain('Denote');
    // Notebook should be FIRST because it's a prefix match (boosted)
    // Without boost, alphabetical order would be: Anote, Denote, Notebook
    expect(result!.options[0].label).toBe('Notebook');
  });

  // Prevents: "what cognitive biases" finding nothing because the file is
  // named what-cognitive-biases (or what_cognitive_biases)
  it('treats spaces, dashes and underscores as the same', () => {
    const metadata: FolderMetadata = {
      '/articles/what-cognitive-biases.md': { id: 'a', type: 'markdown', version: 0 },
      '/articles/what_cognitive_biases_2.md': { id: 'b', type: 'markdown', version: 0 },
      '/articles/Cognitive Load.md': { id: 'c', type: 'markdown', version: 0 },
      '/articles/what-else.md': { id: 'd', type: 'markdown', version: 0 },
    };
    const labels = (q: string) => getCompletions(`[[${q}`, q.length + 2, metadata)!.options.map(o => o.label);

    expect(labels('what cognitive biases')).toEqual([
      'articles/what-cognitive-biases',
      'articles/what_cognitive_biases_2',
    ]);
    expect(labels('cognitive-load')).toEqual(['articles/Cognitive Load']);
    expect(labels('WHAT__COGNITIVE')).toHaveLength(2);
    expect(labels('what  else')).toEqual(['articles/what-else']);
  });

  // Prevents: highlighting the wrong characters once separators collapse
  it('highlights the matched range of the original label', () => {
    const range = (label: string, q: string) => matchLabel(label, normalizeForSearch(q))?.range;
    expect(range('articles/what--cognitive-biases', 'what cognitive')).toEqual([9, 24]);
    expect(range('a/__x', ' x')).toEqual([2, 5]);
    expect(range('İntro-x', 'x')).toEqual([6, 7]);
    expect(range('🙂 notes', 'notes')).toEqual([3, 8]);
    expect(matchLabel('Notes', 'zzz')).toBeNull();
  });

  // Prevents: an exact file name in a folder sinking below loose matches
  // (and out of the 20 shown) because only whole-path prefixes were boosted
  it('ranks by file name, then word start, then shorter path', () => {
    const metadata: FolderMetadata = {
      '/aaa/intro-extra.md': { id: '1', type: 'markdown', version: 0 },
      '/articles/an-introduction.md': { id: '2', type: 'markdown', version: 0 },
      '/articles/intro.md': { id: '3', type: 'markdown', version: 0 },
      '/Intro.md': { id: '4', type: 'markdown', version: 0 },
      '/articles/reintroduce.md': { id: '5', type: 'markdown', version: 0 },
      '/intro/notes.md': { id: '6', type: 'markdown', version: 0 },
    };
    const labels = getCompletions('[[intro', 7, metadata)!.options.map(o => o.label);
    expect(labels).toEqual([
      'Intro',
      'articles/intro',
      'aaa/intro-extra',
      'intro/notes',
      'articles/an-introduction',
      'articles/reintroduce',
    ]);
  });

  it('returns null when metadata is null', () => {
    const result = getCompletions('See [[', 6, null);
    expect(result).toBeNull();
  });

  it('sets from position to after [[ (where query begins)', () => {
    const result = getCompletions('See [[Not', 9, testMetadata);

    expect(result).not.toBeNull();
    // "See " is 4 chars, [[ is 2 chars, so query starts at position 6
    expect(result!.from).toBe(6);
  });
});

describe('relative path suggestions', () => {
  const multiFolderMetadata: FolderMetadata = {
    '/Relay Folder 1/Welcome.md': { id: 'w1', type: 'markdown', version: 0 },
    '/Relay Folder 1/Notes/Ideas.md': { id: 'i1', type: 'markdown', version: 0 },
    '/Relay Folder 1/Notes/Plans.md': { id: 'p1', type: 'markdown', version: 0 },
    '/Relay Folder 2/Welcome.md': { id: 'w2', type: 'markdown', version: 0 },
    '/Relay Folder 2/Archive/Old.md': { id: 'o2', type: 'markdown', version: 0 },
  };

  it('suggests sibling file as basename', () => {
    const result = getCompletions('See [[', 6, multiFolderMetadata, '/Relay Folder 1/Notes/Ideas.md');
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('Plans');
  });

  it('suggests ../ for parent directory files', () => {
    const result = getCompletions('See [[', 6, multiFolderMetadata, '/Relay Folder 1/Notes/Ideas.md');
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('../Welcome');
  });

  it('suggests ../../ for cross-folder files', () => {
    const result = getCompletions('See [[', 6, multiFolderMetadata, '/Relay Folder 1/Notes/Ideas.md');
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('../../Relay Folder 2/Welcome');
    expect(labels).toContain('../../Relay Folder 2/Archive/Old');
  });

  it('shows absolute paths when no currentFilePath', () => {
    const result = getCompletions('See [[', 6, multiFolderMetadata);
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('Relay Folder 1/Welcome');
    expect(labels).toContain('Relay Folder 1/Notes/Ideas');
  });

  it('filters by query on relative paths', () => {
    const result = getCompletions('See [[../', 9, multiFolderMetadata, '/Relay Folder 1/Notes/Ideas.md');
    const labels = result!.options.map(o => o.label);
    expect(labels).toContain('../Welcome');
    expect(labels).not.toContain('Plans');
  });

  it('uses relative path in apply string', () => {
    const result = getCompletions('See [[', 6, multiFolderMetadata, '/Relay Folder 1/Notes/Ideas.md');
    const option = result!.options.find(o => o.label === '../Welcome');
    expect(option).toBeDefined();
    expect(option!.apply).toBe('../Welcome]]');
  });
});

describe('wikilinkAutocomplete EditorView integration', () => {
  const testMetadata: FolderMetadata = {
    '/Notes.md': { id: 'doc-notes', type: 'markdown', version: 0 },
    '/Tasks.md': { id: 'doc-tasks', type: 'markdown', version: 0 },
  };

  function createEditorWithAutocomplete(doc: string, metadata: FolderMetadata) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      doc,
      extensions: [
        markdown(),
        wikilinkAutocomplete(() => metadata),
      ],
      parent,
    });

    return { view, parent };
  }

  function cleanup(view: EditorView, parent: HTMLElement) {
    view.destroy();
    parent.remove();
  }

  /**
   * Wait for completion status to become 'active' (async completion resolution)
   */
  async function waitForCompletion(view: EditorView, maxWait = 100): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = completionStatus(view.state);
      if (status === 'active') return true;
      if (status === null) return false; // No completion triggered
      // status === 'pending', wait a bit
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return false;
  }

  it('triggers completion when [[ is typed', async () => {
    const { view, parent } = createEditorWithAutocomplete('', testMetadata);

    try {
      // Simulate typing [[
      view.dispatch({
        changes: { from: 0, insert: '[[' },
        selection: { anchor: 2 },
      });

      // Trigger completion manually (simulates activateOnTyping)
      startCompletion(view);

      // Wait for async completion to resolve
      const activated = await waitForCompletion(view);
      expect(activated).toBe(true);

      // Check that completions are available
      // currentCompletions returns an array of Completion objects
      const completions = currentCompletions(view.state);
      expect(completions).not.toBeNull();
      expect(completions!.length).toBeGreaterThan(0);
    } finally {
      cleanup(view, parent);
    }
  });

  it('shows filtered completions when query is typed after [[', async () => {
    const { view, parent } = createEditorWithAutocomplete('', testMetadata);

    try {
      // Type [[Not
      view.dispatch({
        changes: { from: 0, insert: '[[Not' },
        selection: { anchor: 5 },
      });

      startCompletion(view);
      await waitForCompletion(view);

      // currentCompletions returns an array of Completion objects
      const completions = currentCompletions(view.state);
      expect(completions).not.toBeNull();

      const labels = completions!.map(c => c.label);
      expect(labels).toContain('Notes');
      expect(labels).not.toContain('Tasks');
    } finally {
      cleanup(view, parent);
    }
  });

  // Prevents: CodeMirror's own fuzzy filter dropping separator-normalised
  // matches that the completion source returned
  it('shows a dashed file name for a query typed with spaces', async () => {
    const metadata: FolderMetadata = {
      ...testMetadata,
      '/what-cognitive-biases.md': { id: 'doc-wcb', type: 'markdown', version: 0 },
    };
    const { view, parent } = createEditorWithAutocomplete('', metadata);

    try {
      view.dispatch({
        changes: { from: 0, insert: '[[what cognitive' },
        selection: { anchor: 16 },
      });

      startCompletion(view);
      await waitForCompletion(view);

      const labels = currentCompletions(view.state).map(c => c.label);
      expect(labels).toEqual(['what-cognitive-biases']);
    } finally {
      cleanup(view, parent);
    }
  });

  it('applies completion correctly when selected', async () => {
    const { view, parent } = createEditorWithAutocomplete('', testMetadata);

    try {
      // Type [[
      view.dispatch({
        changes: { from: 0, insert: '[[' },
        selection: { anchor: 2 },
      });

      startCompletion(view);
      await waitForCompletion(view);

      // Get the first completion to apply manually
      const completions = currentCompletions(view.state);
      expect(completions).not.toBeNull();
      expect(completions!.length).toBeGreaterThan(0);

      const firstCompletion = completions![0];

      // acceptCompletion may not work in happy-dom, so we test that:
      // 1. Completions are available (tested above)
      // 2. The completion has the correct apply string
      expect(firstCompletion.apply).toMatch(/^.+\]\]$/);

      // Manually apply the completion to verify the apply string is correct
      view.dispatch({
        changes: {
          from: 2, // After [[
          to: 2,   // Replace nothing (no query typed)
          insert: firstCompletion.apply as string,
        },
      });

      // Check the resulting text includes the page name and closing brackets
      const text = view.state.doc.toString();
      expect(text).toMatch(/\[\[.+\]\]/);
    } finally {
      cleanup(view, parent);
    }
  });
});

describe('wikilinkAutocomplete - embeds', () => {
  const metadata: FolderMetadata = {
    '/Questions/Control property.md': { id: 'q1', type: 'markdown', version: 0 },
    '/Lenses/Control basics.md': { id: 'l1', type: 'markdown', version: 0 },
    '/Control.md': { id: 'c1', type: 'markdown', version: 0 },
  };

  it('lists question files first after ![[', () => {
    const result = getCompletions('![[contr', 8, metadata);
    expect(result!.options[0].label).toBe('Questions/Control property');
  });

  it('keeps the usual order after [[', () => {
    const result = getCompletions('[[contr', 7, metadata);
    expect(result!.options[0].label).toBe('Control');
  });
});
