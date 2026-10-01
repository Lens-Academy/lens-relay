import { describe, expect, it } from "vitest";
import { googleDocEditUrl, parseGoogleDocUrl } from "./url";

const ID = "1hWdq25Nw17538nk5aNG1_a8PxfNUhFKfaa9r0H6fRP4";

describe("parseGoogleDocUrl", () => {
  it.each([
    [`https://docs.google.com/document/d/${ID}/edit`, null],
    [`https://docs.google.com/document/d/${ID}/edit?usp=sharing`, null],
    [`https://docs.google.com/document/d/${ID}/edit?tab=t.2iafmf6rj9gc#heading=h.abc`, "t.2iafmf6rj9gc"],
    [`https://docs.google.com/document/u/1/d/${ID}/view`, null],
    [`https://docs.google.com/document/d/${ID}`, null],
    [`https://docs.google.com/a/cesia.org/document/d/${ID}/edit?tab=t.1`, "t.1"],
  ])("reads %s", (url, tabId) => {
    expect(parseGoogleDocUrl(url)).toEqual({ documentId: ID, tabId });
  });

  it.each([
    "https://docs.google.com/document/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pub",
    `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://evil.test/document/d/${ID}/edit`,
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseGoogleDocUrl(url)).toBeNull();
  });

  it("builds the edit link back, keeping the tab", () => {
    expect(googleDocEditUrl({ documentId: ID, tabId: "t.0" })).toBe(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`);
    expect(googleDocEditUrl({ documentId: ID, tabId: null })).toBe(`https://docs.google.com/document/d/${ID}/edit`);
  });
});
