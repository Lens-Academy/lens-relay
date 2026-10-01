import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccessDenied, TokenExpired, TokenInvalid } from './App';

const ACCESS_KEY_MESSAGE_URL =
  'https://discord.com/channels/1440725236843806762/1464359318865448970/1522158633738309713';
const HELP_CHANNEL_URL =
  'https://discord.com/channels/1440725236843806762/1464603560346910892';

function expectContactTeamHint() {
  expect(
    screen.getByText(/Can't open that message\? You may not have access to that channel\./),
  ).toHaveTextContent(
    "Can't open that message? You may not have access to that channel. Message someone on the Lens team on Discord, or ask in #help-and-feedback.",
  );
  expect(screen.getByRole('link', { name: '#help-and-feedback' })).toHaveAttribute(
    'href',
    HELP_CHANNEL_URL,
  );
}

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
    expectContactTeamHint();
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
    expectContactTeamHint();
  });

  it('tells visitors without a link to ask the Lens team', () => {
    render(<AccessDenied />);

    expect(screen.getByText(/You need a share link/)).toHaveTextContent(
      'You need a share link to access this editor. Please ask the Lens team for a link, for example in #help-and-feedback on Discord.',
    );
    expect(screen.getByRole('link', { name: '#help-and-feedback' })).toHaveAttribute(
      'href',
      HELP_CHANNEL_URL,
    );
  });
});
