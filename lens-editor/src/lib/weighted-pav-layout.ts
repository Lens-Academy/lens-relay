export interface LayoutItem<Key = string | number> {
  key: Key;
  anchorY: number;
  height: number;
  /** 0 = no displacement penalty; ∞ = hard pin (use Number.POSITIVE_INFINITY). */
  weight: number;
}

export interface LayoutInput<Key = string | number> {
  items: LayoutItem<Key>[];
  gap: number;
}

/**
 * One block holds one or more adjacent cards that have been merged because
 * their overlap constraints became binding. Within a block the cards have
 * fixed relative offsets (each card's top is `blockY + offset`); the block
 * as a whole slides along the y-axis as a rigid body.
 */
interface Block {
  /** Indices into `sorted` (sorted by anchorY). */
  members: number[];
  /** Sum of card heights + gaps within this block. */
  span: number;
  /** Pre-computed: blockY = (Σ w_k · (a_k − δ_k)) / Σ w_k where δ_k is the
   *  within-block offset of card k. ∞-weight pins blockY exactly. */
  blockY: number;
  /** Cached numerator/denominator so we can re-derive blockY after merges. */
  numer: number;
  denom: number;
  /** True if any member has infinite weight — block is pinned. */
  pinned: boolean;
  /** If pinned, the required blockY (first infinite-weight member's anchor − its offset). */
  pinnedY: number;
}

/**
 * Compute non-overlapping y-positions for a set of cards by minimising
 * Σ weight_i · (y_i − anchor_i)² subject to y_i + height_i + gap ≤ y_{i+1}.
 *
 * Returns a Map<key, top-y>.
 */
export function computeWeightedLayout<Key = string | number>(input: LayoutInput<Key>): Map<Key, number> {
  const { items, gap } = input;
  const sorted = [...items].sort((a, b) => a.anchorY - b.anchorY);
  const out = new Map<Key, number>();
  if (sorted.length === 0) return out;

  // δ_k for a single-member block is 0 (the card is the block).
  const blocks: Block[] = sorted.map((it, _i) => {
    const pinned = !isFinite(it.weight);
    return {
      members: [_i],
      span: it.height,
      blockY: it.anchorY,
      numer: pinned ? 0 : it.weight * it.anchorY,
      denom: pinned ? 0 : it.weight,
      pinned,
      pinnedY: it.anchorY,
    };
  });

  // Merge until no adjacent blocks violate the non-overlap constraint.
  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i];
    const b = blocks[i + 1];
    // Required separation: end of `a` + gap ≤ start of `b`.
    const aBottom = a.blockY + a.span;
    const bTop = b.blockY;
    if (bTop >= aBottom + gap) {
      i++;
      continue;
    }

    // Merge b into a. Card offsets within the new block:
    //   members of a keep their offsets (0..a.span - lastCardHeight)
    //   members of b get offset = (a.span + gap + their previous within-b offset)
    const offsetShift = a.span + gap;
    // Recompute b's numerator with shifted offsets:
    //   contribution per member k: w_k · (a_k − (oldDelta_k + offsetShift))
    //   = w_k · (a_k − oldDelta_k) − w_k · offsetShift
    // So new numer = b.numer − b.denom · offsetShift.
    const mergedNumer = a.numer + b.numer - b.denom * offsetShift;
    const mergedDenom = a.denom + b.denom;
    const mergedPinned = a.pinned || b.pinned;
    let mergedPinnedY = 0;
    if (mergedPinned) {
      // If both pinned, they must agree (pinnedY_a == pinnedY_b - offsetShift);
      // otherwise the constraints are infeasible and we let the later pin win
      // (focus changes are user-initiated; spec says focus is a hard pin and
      // the algorithm runs around it).
      if (b.pinned) {
        mergedPinnedY = b.pinnedY - offsetShift;
      } else {
        mergedPinnedY = a.pinnedY;
      }
    }
    let mergedBlockY: number;
    if (mergedPinned) {
      mergedBlockY = mergedPinnedY;
    } else if (mergedDenom === 0) {
      // All members have weight 0 — place block at a.blockY (no preference).
      mergedBlockY = a.blockY;
    } else {
      mergedBlockY = mergedNumer / mergedDenom;
    }

    const merged: Block = {
      members: [...a.members, ...b.members],
      span: a.span + gap + b.span,
      blockY: mergedBlockY,
      numer: mergedNumer,
      denom: mergedDenom,
      pinned: mergedPinned,
      pinnedY: mergedPinnedY,
    };
    blocks.splice(i, 2, merged);
    // Step back to re-check against the previous block.
    if (i > 0) i--;
  }

  // Expand blocks back into per-card positions.
  for (const block of blocks) {
    let offset = 0;
    for (let k = 0; k < block.members.length; k++) {
      const memberIdx = block.members[k];
      const item = sorted[memberIdx];
      out.set(item.key, block.blockY + offset);
      offset += item.height + gap;
    }
  }
  return out;
}
