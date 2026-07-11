import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokenExpired, TokenInvalid } from './App';

const ACCESS_KEY_MESSAGE_URL =
  'https://discord.com/channels/1440725236843806762/1481581688705519689/1510923946168684624';

describe('access key error pages', () => {
  it('directs expired access keys to the current key message', () => {
    render(<TokenExpired />);

    const link = screen.getByRole('link', { name: 'this Discord message' });
    expect(link.closest('p')).toHaveTextContent(
      'Your access key has expired. Get the current access key from this Discord message.',
    );
    expect(link).toHaveAttribute(
      'href',
      ACCESS_KEY_MESSAGE_URL,
    );
  });

  it('directs invalid access keys to the current key message', () => {
    render(<TokenInvalid />);

    const link = screen.getByRole('link', { name: 'this Discord message' });
    expect(link.closest('p')).toHaveTextContent(
      'Your access key is no longer valid. Get the current access key from this Discord message.',
    );
    expect(link).toHaveAttribute(
      'href',
      ACCESS_KEY_MESSAGE_URL,
    );
  });
});
