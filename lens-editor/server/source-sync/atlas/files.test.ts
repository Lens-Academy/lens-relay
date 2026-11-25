import { describe, expect, it } from "vitest";
import { withAcknowledgements } from "./files";

describe("withAcknowledgements", () => {
  it("thanks the chapter's people as the Atlas's site does, before the footnotes", () => {
    const body = "Text.[^note-1]\n\nMore.[^note-2]\n\n[^note-1]: One.\n[^note-2]: Two.";
    expect(withAcknowledgements(body, ["Ada", "Ben", "Cy"])).toBe(
      "Text.[^note-1]\n\nMore.[^note-2]\n\nWe thank Ada, Ben and Cy for their valuable feedback and contributions.\n\n[^note-1]: One.\n[^note-2]: Two.",
    );
  });

  it("ends a body without footnotes with them, and names one person alone", () => {
    expect(withAcknowledgements("Text.", ["Léo Karoubi"])).toBe("Text.\n\nWe thank Léo Karoubi for their valuable feedback and contributions.");
    expect(withAcknowledgements("Text.", [])).toBe("Text.");
    expect(withAcknowledgements("Text.", ["Gurvan R.", "A*B"])).toBe("Text.\n\nWe thank Gurvan R. and A\\*B for their valuable feedback and contributions.");
  });
});
