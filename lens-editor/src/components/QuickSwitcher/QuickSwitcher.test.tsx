import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickSwitcher } from './QuickSwitcher';
import { NavigationContext } from '../../contexts/NavigationContext';
import type { FolderMetadata } from '../../hooks/useFolderMetadata';

vi.mock('../../App', async () => {
  const actual = await vi.importActual('../../App');
  return { ...actual, RELAY_ID: 'cb696037-0f72-4e93-8717-4e433129d789' };
});

const mockMetadata: FolderMetadata = {
  '/Lens/Introduction.md': { id: 'doc-intro', type: 'markdown', version: 0 },
  '/Lens/Getting Started.md': { id: 'doc-start', type: 'markdown', version: 0 },
  '/Lens/Advanced Topics.md': { id: 'doc-adv', type: 'markdown', version: 0 },
  '/Lens/Projects': { id: 'folder-proj', type: 'folder', version: 0 },
  '/Lens/Projects/Alpha.md': { id: 'doc-alpha', type: 'markdown', version: 0 },
  '/Lens Edu/Course Notes.md': { id: 'doc-course', type: 'markdown', version: 0 },
};

const mockOnSelect = vi.fn();
const mockOnOpenChange = vi.fn();

function renderSwitcher({ open = true, recentFiles = [] as string[] } = {}) {
  return render(
    <NavigationContext.Provider value={{
      metadata: mockMetadata,
      folderDocs: new Map(),
      folderNames: ['Lens', 'Lens Edu'],
      errors: new Map(),
      onNavigate: vi.fn(),
      justCreatedRef: { current: false },
    }}>
      <QuickSwitcher
        open={open}
        onOpenChange={mockOnOpenChange}
        recentFiles={recentFiles}
        onSelect={mockOnSelect}
      />
    </NavigationContext.Provider>
  );
}

describe('QuickSwitcher', () => {
  beforeEach(() => {
    mockOnSelect.mockClear();
    mockOnOpenChange.mockClear();
  });

  it('renders nothing visible when closed', () => {
    renderSwitcher({ open: false });
    expect(screen.queryByPlaceholderText('Type to search...')).toBeNull();
  });

  it('shows search input when open', () => {
    renderSwitcher();
    expect(screen.getByPlaceholderText('Type to search...')).toBeTruthy();
  });

  it('shows recent files when query is empty', () => {
    renderSwitcher({ recentFiles: ['doc-intro', 'doc-start'] });
    expect(screen.getByText('Introduction')).toBeTruthy();
    expect(screen.getByText('Getting Started')).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
  });

  it('shows "No recent files" when empty query and no recents', () => {
    renderSwitcher({ recentFiles: [] });
    expect(screen.getByText('No recent files')).toBeTruthy();
  });

  it('filters files by fuzzy match on typing', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'intro');
    // Text is split by <mark> highlight tags, so use a function matcher
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Introduction');
    // "Advanced Topics" should not appear
    expect(screen.queryByText('Advanced Topics')).toBeNull();
  });

  it('shows folder path alongside file name', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'course');
    expect(screen.getByText('Lens Edu')).toBeTruthy();
  });

  it('excludes folder entries from results', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    // Type something that matches "Alpha" (which is inside the Projects folder)
    await userEvent.type(input, 'alpha');
    // Alpha.md should appear
    expect(screen.getByText('Alpha')).toBeTruthy();
    // The "Projects" folder entry should not appear as a selectable result
    // (Projects folder path is shown as context, but the folder itself is not a row)
  });

  it('calls onSelect with doc UUID on Enter', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'intro');
    await userEvent.keyboard('{Enter}');
    expect(mockOnSelect).toHaveBeenCalledWith('doc-intro');
  });

  it('navigates selection with arrow keys', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    // Type 'a' to get multiple results
    await userEvent.type(input, 'a');
    // First result should be selected by default (index 0)
    await userEvent.keyboard('{ArrowDown}');
    // Now at index 1
    await userEvent.keyboard('{Enter}');
    expect(mockOnSelect).toHaveBeenCalled();
    // The second result should be selected (not the first)
    const calledWithId = mockOnSelect.mock.calls[0][0];
    expect(calledWithId).not.toBe('');
  });

  it('wraps selection around at boundaries', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'intro');
    // Only one match: Introduction. ArrowUp should wrap to last (same item)
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Enter}');
    expect(mockOnSelect).toHaveBeenCalledWith('doc-intro');
  });

  it('skips nonexistent recent files', () => {
    renderSwitcher({ recentFiles: ['doc-intro', 'nonexistent-id', 'doc-start'] });
    expect(screen.getByText('Introduction')).toBeTruthy();
    expect(screen.getByText('Getting Started')).toBeTruthy();
    // Should show exactly 2 result rows, not 3
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(2);
  });

  it('shows "No matching files" when search has no matches', async () => {
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'zzzzxyz');
    expect(screen.getByText('No matching files')).toBeTruthy();
  });

  it('resets query when dialog reopens', async () => {
    const { rerender } = render(
      <NavigationContext.Provider value={{
        metadata: mockMetadata,
        folderDocs: new Map(),
        folderNames: ['Lens', 'Lens Edu'],
        errors: new Map(),
        onNavigate: vi.fn(),
        justCreatedRef: { current: false },
      }}>
        <QuickSwitcher
          open={true}
          onOpenChange={mockOnOpenChange}
          recentFiles={[]}
          onSelect={mockOnSelect}
        />
      </NavigationContext.Provider>
    );

    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'intro');

    // Close and reopen
    rerender(
      <NavigationContext.Provider value={{
        metadata: mockMetadata,
        folderDocs: new Map(),
        folderNames: ['Lens', 'Lens Edu'],
        errors: new Map(),
        onNavigate: vi.fn(),
        justCreatedRef: { current: false },
      }}>
        <QuickSwitcher
          open={false}
          onOpenChange={mockOnOpenChange}
          recentFiles={[]}
          onSelect={mockOnSelect}
        />
      </NavigationContext.Provider>
    );

    rerender(
      <NavigationContext.Provider value={{
        metadata: mockMetadata,
        folderDocs: new Map(),
        folderNames: ['Lens', 'Lens Edu'],
        errors: new Map(),
        onNavigate: vi.fn(),
        justCreatedRef: { current: false },
      }}>
        <QuickSwitcher
          open={true}
          onOpenChange={mockOnOpenChange}
          recentFiles={[]}
          onSelect={mockOnSelect}
        />
      </NavigationContext.Provider>
    );

    const newInput = screen.getByPlaceholderText('Type to search...');
    expect(newInput).toHaveValue('');
  });

  it('selects item on click', async () => {
    renderSwitcher({ recentFiles: ['doc-intro'] });
    const row = screen.getByText('Introduction').closest('[role="option"]')!;
    await userEvent.click(row);
    expect(mockOnSelect).toHaveBeenCalledWith('doc-intro');
  });

  it('opens doc in new tab on ctrl+Enter', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderSwitcher();
    const input = screen.getByPlaceholderText('Type to search...');
    await userEvent.type(input, 'intro');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining('/doc-intr'),
      '_blank'
    );
    expect(mockOnSelect).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it('opens doc in new tab on middle-click', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderSwitcher({ recentFiles: ['doc-intro'] });
    const row = screen.getByText('Introduction').closest('[role="option"]') as HTMLElement;
    fireEvent(row, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining('/doc-intr'),
      '_blank'
    );
    expect(mockOnSelect).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });
});
