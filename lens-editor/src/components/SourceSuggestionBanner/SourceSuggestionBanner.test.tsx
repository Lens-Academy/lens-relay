import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceSuggestionBanner } from './SourceSuggestionBanner';

describe('SourceSuggestionBanner', () => {
  it('renders the read-only explanation text', () => {
    render(<SourceSuggestionBanner />);
    expect(screen.getByText(/source mode is read-only while suggesting/i)).toBeInTheDocument();
  });
});
