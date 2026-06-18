import { describe, it, expect } from "vitest";
import { hasCriticMarkup } from "./criticmarkup";

describe("hasCriticMarkup", () => {
  it("detects every CriticMarkup form, ignores plain text", () => {
    expect(hasCriticMarkup("x {>>note<<}")).toBe(true);
    expect(hasCriticMarkup("x {++ins++}")).toBe(true);
    expect(hasCriticMarkup("x {--del--}")).toBe(true);
    expect(hasCriticMarkup("x {~~a~>b~~}")).toBe(true);
    expect(hasCriticMarkup("just prose, no markup")).toBe(false);
  });
});
