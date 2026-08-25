import { describe, expect, it } from "vitest";
import { buildRelayReviewEdits } from "./review-diff";

function apply(original: string, edits: Array<{ old: string; replacement: string }>): string {
  let value = original;
  for (const edit of edits) {
    expect(value.split(edit.old)).toHaveLength(2);
    value = value.replace(edit.old, edit.replacement);
  }
  return value;
}

describe("Relay review diff", () => {
  it("returns no edits for an unchanged article", () => {
    expect(buildRelayReviewEdits("same\n", "same\n")).toEqual([]);
  });

  it.each([
    ["addition", "one\nthree\n", "one\ntwo\nthree\n"],
    ["deletion", "one\ntwo\nthree\n", "one\nthree\n"],
    ["replacement", "one\nbad\nthree\n", "one\ngood\nthree\n"],
    ["final newline", "one\n", "one"],
  ])("builds applicable edits for %s", (_name, original, reviewed) => {
    const edits = buildRelayReviewEdits(original, reviewed);
    expect(apply(original, edits)).toBe(reviewed);
  });

  it("keeps distant changes as independently reviewable edits", () => {
    const middle = Array.from({ length: 20 }, (_, index) => `unchanged ${index}\n`).join("");
    const original = `title old\n${middle}ending old\n`;
    const reviewed = `title new\n${middle}ending new\n`;
    const edits = buildRelayReviewEdits(original, reviewed);
    expect(edits).toHaveLength(2);
    expect(apply(original, edits)).toBe(reviewed);
  });

  it("falls back safely when repeated text cannot be uniquely anchored", () => {
    const original = "same\nsame\nsame\n";
    const reviewed = "same\nchanged\nsame\n";
    const edits = buildRelayReviewEdits(original, reviewed);
    expect(apply(original, edits)).toBe(reviewed);
  });
});
