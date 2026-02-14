import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { WikilinkExtension } from './wikilinkParser';

function parseContent(content: string) {
  const state = EditorState.create({
    doc: content,
    extensions: [markdown({ extensions: [WikilinkExtension] })],
  });
  return syntaxTree(state);
}

function getNodeNames(content: string): string[] {
  const tree = parseContent(content);
  const names: string[] = [];
  tree.iterate({
    enter(node) {
      names.push(node.name);
    },
  });
  return names;
}

describe('WikilinkExtension parsing', () => {
  it('parses [[Page]] as Wikilink node', () => {
    const names = getNodeNames('[[Page]]');

    expect(names).toContain('Wikilink');
  });

  it('creates WikilinkMark nodes for [[ and ]]', () => {
    const names = getNodeNames('[[Page]]');

    const markCount = names.filter((n) => n === 'WikilinkMark').length;
    expect(markCount).toBe(2);
  });

  it('creates WikilinkContent node for page name', () => {
    const names = getNodeNames('[[Page Name]]');

    expect(names).toContain('WikilinkContent');
  });

  it('does not parse empty wikilink [[]]', () => {
    const names = getNodeNames('[[]]');

    expect(names).not.toContain('Wikilink');
  });

  it('does not parse unclosed wikilink', () => {
    const names = getNodeNames('[[Page');

    expect(names).not.toContain('Wikilink');
  });

  it('parses wikilink embedded in text', () => {
    const names = getNodeNames('See [[Page]] here');

    expect(names).toContain('Wikilink');
  });

  it('parses multiple wikilinks', () => {
    const names = getNodeNames('[[One]] and [[Two]]');

    const wikilinkCount = names.filter((n) => n === 'Wikilink').length;
    expect(wikilinkCount).toBe(2);
  });

  it('does not conflict with regular markdown links', () => {
    const names = getNodeNames('[text](url)');

    expect(names).not.toContain('Wikilink');
    expect(names).toContain('Link');
  });

  it('parses ![[Page]] as Wikilink node', () => {
    const names = getNodeNames('![[Page]]');
    expect(names).toContain('Wikilink');
  });

  it('creates WikilinkContent for embed syntax', () => {
    const tree = parseContent('![[Page Name]]');
    let contentText = '';
    tree.iterate({
      enter(node) {
        if (node.name === 'WikilinkContent') {
          contentText = '![[Page Name]]'.slice(node.from, node.to);
        }
      },
    });
    expect(contentText).toBe('Page Name');
  });

  it('does not parse empty embed ![[]]', () => {
    const names = getNodeNames('![[]]');
    expect(names).not.toContain('Wikilink');
  });
});
