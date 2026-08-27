import { describe, it, expect } from 'vitest';
import { SLIDER_MAX, MAX_AGO_MS, sliderToMs, msToSlider } from './timeFilter';

describe('time slider mapping', () => {
  it('round-trips every finite slider position', () => {
    for (let pos = 1; pos < SLIDER_MAX; pos++) {
      expect(msToSlider(sliderToMs(pos))).toBe(pos);
    }
  });

  it('maps the oldest finite position to exactly the max age', () => {
    expect(sliderToMs(SLIDER_MAX - 1)).toBe(MAX_AGO_MS);
    expect(msToSlider(MAX_AGO_MS)).toBe(SLIDER_MAX - 1);
  });

  it('reserves the top position for the all-time sentinel', () => {
    expect(sliderToMs(SLIDER_MAX)).toBe(Infinity);
    expect(msToSlider(Infinity)).toBe(SLIDER_MAX);
    expect(sliderToMs(0)).toBe(0);
    expect(msToSlider(0)).toBe(0);
  });

  it('is monotonic in age', () => {
    for (let pos = 1; pos < SLIDER_MAX; pos++) {
      expect(sliderToMs(pos)).toBeGreaterThan(sliderToMs(pos - 1));
    }
  });
});
