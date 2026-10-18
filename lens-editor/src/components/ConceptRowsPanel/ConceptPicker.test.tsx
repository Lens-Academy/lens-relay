import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConceptPicker } from './ConceptPicker';

describe('ConceptPicker', () => {
  it('refuses a new concept name a wikilink cannot hold', () => {
    const onPick = vi.fn();
    render(<ConceptPicker concepts={[]} onPick={onPick} onClose={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Concept name' });
    for (const name of ['C# basics', 'a|b', '[draft] x']) {
      fireEvent.change(input, { target: { value: name } });
      expect(screen.queryByText(/Create new concept/)).toBeNull();
      expect(screen.getByText(/cannot contain .*# \[ \]/)).toBeInTheDocument();
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'C sharp basics' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith({ name: 'C sharp basics' });
  });
});
