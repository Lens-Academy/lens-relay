// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CountInput } from './CountInput';

describe('CountInput', () => {
  it('lets the box go empty while typing, saves only whole counts, and shows the saved count on leaving', () => {
    const onValue = vi.fn();
    const { getByRole } = render(<CountInput value={200} max={1000} onValue={onValue} />);
    const box = getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '0' } });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '25' } });
    expect(onValue).toHaveBeenLastCalledWith(25);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(box.value).toBe('200');
  });
});
