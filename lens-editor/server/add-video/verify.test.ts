import { describe, it, expect } from "vitest";
import { verifyCorrection } from "./verify";

const words = (s: string) => s.trim().split(/\s+/);

describe("verifyCorrection", () => {
  // The whole point of the cleanup pass: punctuation and casing change, the
  // words do not. That must register as a perfect match.
  it("accepts a pure punctuation and capitalisation pass", () => {
    const original = words("hi so this channel is about ai safety");
    const corrected = words("Hi, so this channel is about AI safety.");

    const result = verifyCorrection(original, corrected);
    expect(result.ok).toBe(true);
    expect(result.stats.inserted).toBe(0);
    expect(result.stats.droppedNonFiller).toBe(0);
  });

  it("accepts filler removal at a realistic rate", () => {
    const body = Array(100).fill("alignment").join(" ");
    const original = words(
      `so um the model uh you know learns the goal ${body}`,
    );
    const corrected = words(`So the model learns the goal. ${body}`);

    expect(verifyCorrection(original, corrected).ok).toBe(true);
  });

  // The failure that matters most: a lost chunk on a long transcript, which is
  // invisible in the finished doc.
  it("rejects a truncated transcript", () => {
    const original = words(Array(100).fill("alignment").join(" "));
    const corrected = words(Array(50).fill("alignment").join(" "));

    const result = verifyCorrection(original, corrected);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/lost/);
  });

  it("rejects fabricated content", () => {
    const original = words(Array(100).fill("alignment").join(" "));
    const corrected = words(
      Array(100).fill("alignment").join(" ") +
        " furthermore the author concludes that safety research is essential",
    );

    const result = verifyCorrection(original, corrected);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/introduced/);
  });

  it("rejects paraphrasing that drops real words", () => {
    const original = words(
      "the agent learns to value keys not as an instrumental goal but as a terminal goal " +
        Array(60).fill("padding").join(" "),
    );
    const corrected = words(Array(60).fill("padding").join(" "));

    const result = verifyCorrection(original, corrected);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty result", () => {
    expect(verifyCorrection(words("hello world"), []).ok).toBe(false);
  });

  // A four-person interview spends its entire non-filler budget on discourse
  // markers, and was rejected in production for removing exactly what the
  // prompt asked it to remove.
  it("accepts discourse-marker removal from a conversational transcript", () => {
    // Marker density kept realistic: a transcript that is two-thirds filler
    // would (rightly) trip the truncation rule instead.
    const body = Array(700).fill("alignment").join(" ");
    const chatter = Array(10)
      .fill(">> you know the model is sort of kind of aligned i mean really")
      .join(" ");
    const original = words(`${chatter} ${body}`);
    const corrected = words(
      `${Array(10).fill("The model is aligned, really.").join(" ")} ${body}`,
    );

    const result = verifyCorrection(original, corrected);
    expect(result.ok).toBe(true);
    expect(result.stats.droppedNonFiller).toBe(0);
  });

  it("counts a stutter's repeat as droppable but not the word itself", () => {
    const padding = Array(60).fill("padding").join(" ");
    const original = words(`the the model is is aligned ${padding}`);
    const corrected = words(`The model is aligned. ${padding}`);

    expect(verifyCorrection(original, corrected).stats.droppedNonFiller).toBe(0);
  });

  // The allowance is per occurrence, so it must not become a licence to delete
  // every "know" or "of" in a transcript.
  it("still counts standalone content words beyond the marker allowance", () => {
    const original = words(
      "you know we know the answer and we know the reason " +
        Array(20).fill("padding").join(" "),
    );
    // "you know" excuses one "know"; the other two are content loss.
    const corrected = words(
      "we the answer and we the reason " + Array(20).fill("padding").join(" "),
    );

    const result = verifyCorrection(original, corrected);
    expect(result.stats.droppedNonFiller).toBe(2);
  });
});
