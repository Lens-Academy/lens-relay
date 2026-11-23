import { describe, it, expect } from "vitest";
import {
  addQuestionIds,
  shouldProcessPath,
  insertOnlyUnifiedDiff,
} from "./question-ids";

const uuid = () => "11111111-2222-4333-8444-555555555555";
const uuidSeq = () => {
  let n = 0;
  return () => `0000000${++n}-0000-4000-8000-000000000000`;
};

describe("addQuestionIds", () => {
  it("inserts an id line after a bare header without id", () => {
    const md =
      "## Segment\n\n#### Question\nquestion:: What?\nanswer:: That.\n";
    const r = addQuestionIds(md, uuid);
    expect(r.text).toBe(
      "## Segment\n\n#### Question\nid:: 11111111-2222-4333-8444-555555555555\nquestion:: What?\nanswer:: That.\n",
    );
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]).toEqual({
      offset: md.indexOf("question::"),
      headerLine: 3,
      text: "id:: 11111111-2222-4333-8444-555555555555\n",
    });
  });

  it("leaves a bare header that already has an id alone (idempotent)", () => {
    const md =
      "#### Question\nquestion:: Q\nid:: abc\n\n#### Question\nquestion:: R\n";
    const first = addQuestionIds(md, uuidSeq());
    expect(first.inserts.map((i) => i.headerLine)).toEqual([5]);
    const second = addQuestionIds(first.text, uuidSeq());
    expect(second.inserts).toHaveLength(0);
    expect(second.text).toBe(first.text);
  });

  it("does not match a titled header", () => {
    const md =
      "#### Question: Open\nquestion:: Q\n\n#### Questions\nfoo\n\n#### question\nbar\n";
    const r = addQuestionIds(md, uuid);
    expect(r.inserts).toHaveLength(0);
    expect(r.text).toBe(md);
  });

  it("handles a header at end of file (with and without trailing newline)", () => {
    const withNl = "intro\n#### Question\n";
    expect(addQuestionIds(withNl, uuid).text).toBe(
      "intro\n#### Question\nid:: 11111111-2222-4333-8444-555555555555\n",
    );
    const noNl = "intro\n#### Question";
    expect(addQuestionIds(noNl, uuid).text).toBe(
      "intro\n#### Question\nid:: 11111111-2222-4333-8444-555555555555",
    );
  });

  it("preserves CRLF line endings", () => {
    const md = "## S\r\n\r\n#### Question\r\nquestion:: Q\r\n";
    const r = addQuestionIds(md, uuid);
    expect(r.text).toBe(
      "## S\r\n\r\n#### Question\r\nid:: 11111111-2222-4333-8444-555555555555\r\nquestion:: Q\r\n",
    );
    expect(r.inserts[0].text).toBe(
      "id:: 11111111-2222-4333-8444-555555555555\r\n",
    );
    // Unterminated CRLF document: the added line uses the dominant EOL.
    expect(addQuestionIds("a\r\n#### Question", uuid).text).toBe(
      "a\r\n#### Question\r\nid:: 11111111-2222-4333-8444-555555555555",
    );
  });

  it("only looks for id:: inside the header's own field block", () => {
    const md = "#### Question\nquestion:: Q\n## Next\nid:: belongs-to-next\n";
    const r = addQuestionIds(md, uuid);
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0].headerLine).toBe(1);
  });

  it("allows trailing whitespace on the header and accepts levels 2-6", () => {
    const md = "## Question  \nq\n###### Question\nq\n# Question\nq\n";
    const r = addQuestionIds(md, uuidSeq());
    expect(r.inserts.map((i) => i.headerLine)).toEqual([1, 3]);
  });

  it("reports offsets relative to the original text, ascending", () => {
    const md = "#### Question\na\n#### Question\nb\n";
    const r = addQuestionIds(md, uuidSeq());
    expect(r.inserts.map((i) => i.offset)).toEqual([14, 30]);
    // Applying inserts in descending order to the original reproduces `text`.
    let s = md;
    for (const ins of [...r.inserts].reverse()) {
      s = s.slice(0, ins.offset) + ins.text + s.slice(ins.offset);
    }
    expect(s).toBe(r.text);
  });
});

describe("shouldProcessPath (caller-side filter)", () => {
  it("skips anything under a surveys/ directory", () => {
    expect(shouldProcessPath("/surveys/week1.md")).toBe(false);
    expect(shouldProcessPath("surveys/week1.md")).toBe(false);
    expect(shouldProcessPath("/course/surveys/week1.md")).toBe(false);
    // A survey document with a bare header is never handed to the transform.
    const surveyMd = "#### Question\nquestion:: Q\n";
    const path = "/surveys/intake.md";
    const processed = shouldProcessPath(path)
      ? addQuestionIds(surveyMd, uuid).text
      : surveyMd;
    expect(processed).toBe(surveyMd);
  });

  it("keeps markdown elsewhere, rejects non-markdown", () => {
    expect(shouldProcessPath("/course/surveys-notes.md")).toBe(true);
    expect(shouldProcessPath("/my-surveys.md")).toBe(true);
    expect(shouldProcessPath("/attachments/x.png")).toBe(false);
  });
});

describe("insertOnlyUnifiedDiff", () => {
  it("renders a hunk per insert with context", () => {
    const md = "l1\nl2\n#### Question\nq:: a\nl5\nl6\nl7\n";
    const r = addQuestionIds(md, uuid);
    const d = insertOnlyUnifiedDiff("x.md", md, r.inserts, 2);
    expect(d).toBe(
      [
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -2,4 +2,5 @@",
        " l2",
        " #### Question",
        "+id:: 11111111-2222-4333-8444-555555555555",
        " q:: a",
        " l5",
        "",
      ].join("\n"),
    );
  });
});
