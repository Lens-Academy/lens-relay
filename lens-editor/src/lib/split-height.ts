export interface SplitHeightInput {
  topContent: number;
  bottomContent: number;
  available: number;
  minHeight: number;
}

export interface SplitHeightResult {
  topHeight: number;
  bottomHeight: number;
}

export function computeSplitHeight(input: SplitHeightInput): SplitHeightResult {
  const { topContent, bottomContent, available, minHeight } = input;

  // Zero content: split evenly
  if (topContent <= 0 && bottomContent <= 0) {
    const half = Math.round(available / 2);
    return { topHeight: half, bottomHeight: available - half };
  }

  // Effective content (enforce minimum)
  const top = Math.max(topContent, minHeight);
  const bottom = Math.max(bottomContent, minHeight);

  // Both fit: each gets its content height
  if (top + bottom <= available) {
    return { topHeight: top, bottomHeight: bottom };
  }

  // Proportional split with 35-65% clamping
  const total = top + bottom;
  const ratio = top / total;
  const clamped = Math.min(0.65, Math.max(0.35, ratio));
  let topHeight = Math.round(available * clamped);
  let bottomHeight = available - topHeight;

  // Redistribute: if one panel doesn't need its full share, give excess to other
  if (top < topHeight) {
    bottomHeight += topHeight - top;
    topHeight = top;
  } else if (bottom < bottomHeight) {
    topHeight += bottomHeight - bottom;
    bottomHeight = bottom;
  }

  return { topHeight, bottomHeight };
}
