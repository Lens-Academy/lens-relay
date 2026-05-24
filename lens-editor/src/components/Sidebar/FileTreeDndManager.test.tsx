/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { FileTree } from './FileTree';
import type { TreeNode } from '../../lib/tree-utils';

const capturedTreeProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('react-arborist', async () => {
  const React = await import('react');
  return {
    Tree: React.forwardRef((_props: Record<string, unknown>, _ref) => {
      capturedTreeProps.push(_props);
      return <div role="tree" />;
    }),
  };
});

describe('FileTree DnD manager', () => {
  afterEach(() => {
    capturedTreeProps.length = 0;
    cleanup();
  });

  it('passes one shared DnD manager to every react-arborist Tree instance', () => {
    const data: TreeNode[] = [
      {
        id: '/Lens',
        name: 'Lens',
        path: 'Lens',
        isFolder: true,
        children: [],
      },
    ];

    render(
      <>
        <FileTree data={data} />
        <FileTree data={data} />
      </>
    );

    expect(capturedTreeProps).toHaveLength(2);
    expect(capturedTreeProps[0].dndManager).toBeTruthy();
    expect(capturedTreeProps[1].dndManager).toBe(capturedTreeProps[0].dndManager);
  });

  it('disables file dragging when no move handler is provided', () => {
    const file: TreeNode = {
      id: '/Lens/Page.html',
      name: 'Page.html',
      path: 'Lens/Page.html',
      isFolder: false,
      docId: 'page-doc',
    };

    render(<FileTree data={[file]} />);

    expect(capturedTreeProps).toHaveLength(1);
    const disableDrag = capturedTreeProps[0].disableDrag as (data: TreeNode) => boolean;
    expect(disableDrag(file)).toBe(true);
  });
});
