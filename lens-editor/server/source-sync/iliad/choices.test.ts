import { describe, expect, it } from "vitest";
import { choicesIn } from "./choices";

// The sentences are Iliad's own (iliad-intensive.org, October 2026), shortened.
describe("choicesIn", () => {
  it("reads a sentence that offers its links as alternatives", () => {
    expect(choicesIn("**Reading (30 min):** Read [Pretraining data filtering](https://a.org/1), or [SGTM](https://a.org/2), or [persona selection model (PSM)](https://a.org/3).")).toEqual([
      { pick: 1, options: ["https://a.org/1", "https://a.org/2", "https://a.org/3"] },
    ]);
    // The "or" only before the last link, a link in the middle of an option, and a sentence after the list.
    expect(choicesIn("**Reading (30 mins)**: [Detecting misuse](https://a.org/1), [Classifiers](https://a.org/2), or read about the [famous](https://a.org/3) jailbreaker [Pliny](https://a.org/4). Or any other paper.")).toEqual([
      { pick: 1, options: ["https://a.org/1", "https://a.org/2", "https://a.org/3", "https://a.org/4"] },
    ]);
  });

  it("reads a sentence that says to pick, and takes the first link of each item of the list below it as an option", () => {
    const md = [
      "Spend **25 minutes** reading the following texts. Pick one most interesting to you.",
      "* [Coherent extrapolated volition](https://a.org/cev)",
      "* [Intent alignment](https://a.org/intent)  ",
      "* [Corrigibility](https://a.org/corrigibility)",
      "",
      "Then discuss.",
    ].join("\n\n");
    expect(choicesIn(md)).toEqual([{ pick: 1, options: ["https://a.org/cev", "https://a.org/intent", "https://a.org/corrigibility"] }]);
    const accounts = [
      "Read the explanation below and choose one primary account.",
      "* [Hugging Face's disclosure](https://a.org/hf): what they knew. Extension: the [technical timeline](https://a.org/timeline)\n- [Report](https://x.com/r) from an employee",
      "* [OpenAI's August investigation](https://a.org/openai): the background. The [September update](https://a.org/sept) shows how it developed.",
    ].join("\n\n");
    expect(choicesIn(accounts)).toEqual([{ pick: 1, options: ["https://a.org/hf", "https://x.com/r", "https://a.org/openai"] }]);
    expect(choicesIn("Final project: replicate Figure 1 from one of these papers:\n\n* [Inference only](https://a.org/a)\n* [On a GPU](https://a.org/b)")).toEqual([
      { pick: 1, options: ["https://a.org/a", "https://a.org/b"] },
    ]);
    expect(choicesIn("Choose two of the following:\n\n1. [A](https://a.org/a)\n2. [B](https://a.org/b)\n3. [C](https://a.org/c)")[0].pick).toBe(2);
  });

  it("counts an item's nested list as part of the item", () => {
    expect(choicesIn("Pick one:\n\n* [A](https://a.org/a)\n\t* [A, part two](https://a.org/a2)\n   * [A, part three](https://a.org/a3)\n* [B](https://a.org/b)")).toEqual([
      { pick: 1, options: ["https://a.org/a", "https://a.org/b"] },
    ]);
  });

  it("finds no choice where the text names no number to pick or offers no alternatives", () => {
    for (const md of [
      // No number to pick: the hand import kept these readings as a list, and the groups made by hand leave them out.
      "Spend **25 minutes** reading the following texts, concentrating on the one most interesting to you.\n\n* [Training stories](https://a.org/1)\n* [Reward misspecification](https://a.org/2)",
      "Skim all five approaches, then choose the one that initially seems most viable and the one that seems least viable.\n\n1. [A](https://a.org/1)\n2. [B](https://a.org/2)",
      "Read [A](https://a.org/1) and [B](https://a.org/2), or skip ahead.",
      "Read [A](https://a.org/1). Or read [B](https://a.org/2).",
      "Readings: [A](https://a.org/1), [B](https://a.org/2), [C](https://a.org/3).",
      "Pick one most interesting to you.\n\nThen discuss [A](https://a.org/1) and [B](https://a.org/2).",
      // Alternatives that are not a reading instruction, or that are extras.
      "You optimize an attack against an open model (for instance with [GCG suffixes](https://a.org/1), or [the multimodal version](https://a.org/2) for VLMs).",
      "Optionally, read [A](https://a.org/1) or [B](https://a.org/2).",
      "If you finish early, read [A](https://a.org/1) or [B](https://a.org/2).",
      "Optionally, pick one of these:\n\n* [A](https://a.org/1)\n* [B](https://a.org/2)",
      // A pick sentence that is not the last of its paragraph is not about the list below.
      "Pick one most interesting to you. Then come back here.\n\n* [A](https://a.org/1)\n* [B](https://a.org/2)",
    ]) {
      expect(choicesIn(md)).toEqual([]);
    }
  });

  it("takes the number to pick from the sentence that offers the choice", () => {
    expect(choicesIn("Read [A](https://a.org/a), or [B](https://a.org/b), or [C](https://a.org/c). For the exercise, pick two of [D](https://a.org/d), [E](https://a.org/e) and [F](https://a.org/f).")).toEqual([
      { pick: 1, options: ["https://a.org/a", "https://a.org/b", "https://a.org/c"] },
      { pick: 2, options: ["https://a.org/d", "https://a.org/e", "https://a.org/f"] },
    ]);
  });

  it("reads alternatives with a hedge on the last of them as a choice", () => {
    expect(choicesIn("**Reading (30 min):** Read Anthropic's [RSP](https://a.org/1), OpenAI's [Preparedness Framework](https://a.org/2), or if you want to go more in depth [pacing the frontier](https://a.org/3).")).toEqual([
      { pick: 1, options: ["https://a.org/1", "https://a.org/2", "https://a.org/3"] },
    ]);
  });

  it("keeps a link whole when its text holds a full stop", () => {
    expect(choicesIn("Read [Why and When. A Review](https://a.org/1) or [B](https://a.org/2).")).toEqual([{ pick: 1, options: ["https://a.org/1", "https://a.org/2"] }]);
  });
});
