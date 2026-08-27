export interface ReviewEdit {
  old: string;
  replacement: string;
}

interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function lines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function longestIncreasingPairs(pairs: Array<[number, number]>): Array<[number, number]> {
  const tails: number[] = [];
  const tailIndices: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const value = pairs[i][1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    previous[i] = low > 0 ? tailIndices[low - 1] : -1;
    tailIndices[low] = i;
  }
  const result: Array<[number, number]> = [];
  let cursor = tailIndices[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    result.push(pairs[cursor]);
    cursor = previous[cursor];
  }
  return result.reverse();
}

function patienceHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  const visit = (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => {
    while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) {
      oldStart += 1;
      newStart += 1;
    }
    while (oldStart < oldEnd && newStart < newEnd && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    if (oldStart === oldEnd && newStart === newEnd) return;

    const oldCounts = new Map<string, { count: number; index: number }>();
    const newCounts = new Map<string, { count: number; index: number }>();
    for (let i = oldStart; i < oldEnd; i++) {
      const found = oldCounts.get(oldLines[i]);
      oldCounts.set(oldLines[i], { count: (found?.count ?? 0) + 1, index: i });
    }
    for (let i = newStart; i < newEnd; i++) {
      const found = newCounts.get(newLines[i]);
      newCounts.set(newLines[i], { count: (found?.count ?? 0) + 1, index: i });
    }
    const pairs: Array<[number, number]> = [];
    for (const [line, oldValue] of oldCounts) {
      const newValue = newCounts.get(line);
      if (oldValue.count === 1 && newValue?.count === 1) pairs.push([oldValue.index, newValue.index]);
    }
    pairs.sort((left, right) => left[0] - right[0]);
    const anchors = longestIncreasingPairs(pairs);
    if (!anchors.length) {
      hunks.push({ oldStart, oldEnd, newStart, newEnd });
      return;
    }
    let previousOld = oldStart;
    let previousNew = newStart;
    for (const [anchorOld, anchorNew] of anchors) {
      visit(previousOld, anchorOld, previousNew, anchorNew);
      previousOld = anchorOld + 1;
      previousNew = anchorNew + 1;
    }
    visit(previousOld, oldEnd, previousNew, newEnd);
  };
  visit(0, oldLines.length, 0, newLines.length);
  return hunks.sort((left, right) => left.oldStart - right.oldStart);
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
}

/** Build bottom-up, uniquely anchored replacements suitable for Relay MCP edit. */
export function buildRelayReviewEdits(
  original: string,
  reviewed: string,
  options: { allowWholeDocumentFallback?: boolean } = {},
): ReviewEdit[] {
  if (original === reviewed) return [];
  const oldLines = lines(original);
  const newLines = lines(reviewed);
  const hunks = patienceHunks(oldLines, newLines);
  const edits: ReviewEdit[] = [];
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    const lowerBound = index === 0 ? 0 : hunks[index - 1].oldEnd;
    const upperBound = index + 1 === hunks.length ? oldLines.length : hunks[index + 1].oldStart;
    let before = hunk.oldStart;
    let after = hunk.oldEnd;
    let old = oldLines.slice(before, after).join("");
    while (occurrences(original, old) !== 1 && (before > lowerBound || after < upperBound)) {
      if (before > lowerBound) before -= 1;
      if (after < upperBound) after += 1;
      old = oldLines.slice(before, after).join("");
    }
    if (!old || occurrences(original, old) !== 1) {
      if (options.allowWholeDocumentFallback === false) {
        throw new Error("Review changes cannot be split into uniquely anchored suggestions");
      }
      return [{ old: original, replacement: reviewed }];
    }
    if (options.allowWholeDocumentFallback === false && old === original) {
      throw new Error("Review changes cannot be split into uniquely anchored suggestions");
    }
    const prefix = oldLines.slice(before, hunk.oldStart).join("");
    const suffix = oldLines.slice(hunk.oldEnd, after).join("");
    edits.push({
      old,
      replacement: `${prefix}${newLines.slice(hunk.newStart, hunk.newEnd).join("")}${suffix}`,
    });
  }
  return edits.reverse();
}
