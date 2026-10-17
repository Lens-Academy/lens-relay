// @vitest-environment node -- the live test makes real requests; under happy-dom (vitest 4 ignores the config's environmentMatchGlobs) fetch applies browser CORS rules.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermanentImageError } from "../types";
import { publishedCommit, readSnapshot, SITE, snapshotFromDir, type FetchBytes } from "./snapshot";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "snapshot");
const COMMIT = "d5fec17706ceed1fa028ca949b97b92dcc2f5f7e";
const OTHER_COMMIT = "46ea03c0000000000000000000000000000000aa";
const DEPLOYED = "Sun, 11 Oct 2026 16:13:08 GMT";
const SCHEDULE_URL = `https://raw.githubusercontent.com/iliad-team/iliad-intensive/${COMMIT}/schedule.yaml`;

const home = (commit: string) =>
  `<html><body><main>Iliad Intensive</main><footer>Built 11 October 2026 · commit <a href="https://github.com/iliad-team/iliad-intensive/commit/${commit}">${commit.slice(0, 7)}</a></footer></body></html>`;

type Served = string | { body?: string; status?: number; lastModified?: string | null } | (() => string);

/** The published site and the repo's raw files, served from the fixture directory. */
function fakeSite(changes: Record<string, Served | undefined> = {}) {
  const served: Record<string, Served | undefined> = {
    [`${SITE}/`]: home(COMMIT),
    [SCHEDULE_URL]: readFileSync(join(FIXTURES, "schedule.yaml"), "utf8"),
    [`${SITE}/uploads/aixi/roadmap.svg`]: readFileSync(join(FIXTURES, "uploads/aixi/roadmap.svg"), "utf8"),
  };
  for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".mdx"))) {
    const slug = name.replace(".mdx", "");
    served[`${SITE}/downloads/${slug}/${slug}.mdx`] = readFileSync(join(FIXTURES, name), "utf8");
  }
  Object.assign(served, changes);

  const requests: { url: string; userAgent: string | undefined }[] = [];
  const fetchBytes: FetchBytes = async (url, opts) => {
    requests.push({ url, userAgent: opts.headers?.["User-Agent"] });
    const entry = served[url];
    const file = typeof entry === "function" ? entry() : entry;
    const { body = "", status = 200, lastModified = DEPLOYED } = file === undefined ? { status: 404 } : typeof file === "string" ? { body: file } : file;
    const bytes = new TextEncoder().encode(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: "",
      headers: new Headers(lastModified ? { "last-modified": lastModified } : {}),
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  return { fetchBytes, requests };
}

describe("publishedCommit", () => {
  it("reads the source commit from the home page footer in one request, with a User-Agent", async () => {
    const site = fakeSite();
    expect(await publishedCommit(site.fetchBytes)).toBe(COMMIT);
    expect(site.requests).toEqual([{ url: `${SITE}/`, userAgent: expect.stringContaining("Mozilla/5.0") }]);
  });

  it("fails when the footer does not name exactly one commit", async () => {
    await expect(publishedCommit(fakeSite({ [`${SITE}/`]: "<html>no footer</html>" }).fetchBytes)).rejects.toThrow(
      "names 0 source commits; its footer should link to exactly one",
    );
    await expect(publishedCommit(fakeSite({ [`${SITE}/`]: home(COMMIT) + home(OTHER_COMMIT) }).fetchBytes)).rejects.toThrow("names 2 source commits");
  });

  it("names the URL when the request fails", async () => {
    await expect(publishedCommit(fakeSite({ [`${SITE}/`]: { status: 503 } }).fetchBytes)).rejects.toThrow(`Iliad: ${SITE}/ answered 503`);
    const down: FetchBytes = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(publishedCommit(down)).rejects.toThrow(`Iliad: ${SITE}/: fetch failed`);
  });
});

describe("readSnapshot", () => {
  it("lists every scheduled worksheet in taught order, numbering only a day's several parts", async () => {
    const site = fakeSite();
    const snapshot = await readSnapshot(site.fetchBytes);

    expect(snapshot.commit).toBe(COMMIT);
    expect(snapshot.worksheets.map((w) => `${w.code} ${w.slug}`)).toEqual([
      "0 prerequisites",
      "D.2 policy-gradients-misgeneralization",
      "D.3.1 solomonoff-induction",
      "D.3.2 aixi",
      "E.3 worst-case-interp",
    ]);
    // The format-demo sheet is published and unlisted: it is never asked for.
    expect(site.requests.some((r) => r.url.includes("example"))).toBe(false);
    // The schedule is read at the commit the site was built from.
    expect(site.requests.map((r) => r.url)).toContain(SCHEDULE_URL);
    expect(site.requests.every((r) => r.userAgent)).toBe(true);
  });

  it("fills a worksheet from the schedule and the built MDX's frontmatter", async () => {
    const { worksheets } = await readSnapshot(fakeSite().fetchBytes);
    expect(worksheets[3]).toEqual({
      slug: "aixi",
      cluster: { id: "D", label: "D — Agency", urlSlug: "agency" },
      dayCode: "D.3",
      dayTitle: "AIXI",
      code: "D.3.2",
      title: "AIXI",
      summary: "Exploring the Bayesian optimal policy for history based reinforcement learning.",
      contributors: ["David Quarel (ARENA)"],
      slides: null,
      pageUrl: "https://iliad-intensive.org/agency/aixi/",
      mdx: [
        "",
        "$\\gdef\\cA{\\mathcal{A}}$",
        "",
        "## Prerequisites",
        "",
        "- [Solomonoff Induction](/agency/solomonoff-induction) — **start there first.**",
        "",
        '<Figure src="/uploads/aixi/roadmap.svg" alt="diagram" />',
        "",
      ].join("\n"),
    });

    const [prerequisites, policyGradients, , , worstCase] = worksheets;
    expect(prerequisites).toMatchObject({ code: "0", dayCode: "0", cluster: { id: "0", urlSlug: "foundations" }, contributors: [] });
    // A folded summary is one line; `slides: { url, title }` gives its URL.
    expect(policyGradients.summary).toBe(
      "Implement Vanilla Policy Gradient to train a neural network using reinforcement learning, and explore emperically the concepts of goal misgeneralisation in a toy environment.",
    );
    expect(policyGradients.slides).toBe("https://drive.google.com/drive/folders/18NswW6zYnDp9KLKjG_1BwctSPITOjZ-A");
    // No deck of its own: the day's deck in schedule.yaml stands in, as on the site.
    expect(worstCase).toMatchObject({ summary: null, slides: "https://drive.google.com/file/d/1CqJtSUFLZ_L-kSsSzvSJGXfuf1Lbq5Un/view" });
  });

  it("throws one error naming everything the site and the schedule disagree on", async () => {
    const site = fakeSite({
      [`${SITE}/downloads/aixi/aixi.mdx`]: undefined,
      [`${SITE}/downloads/solomonoff-induction/solomonoff-induction.mdx`]: '---\ncluster: "D"\nday: "D.4"\ntitle: Solomonoff Induction\n---\n\nMoved.\n',
      [`${SITE}/downloads/prerequisites/prerequisites.mdx`]: "No frontmatter at all.\n",
    });
    await expect(readSnapshot(site.fetchBytes)).rejects.toThrow(
      "Iliad snapshot at d5fec17 is inconsistent: " +
        "prerequisites (0): the built MDX has no readable frontmatter; " +
        "solomonoff-induction (D.3.1): the built MDX is for day D.4 of cluster D, schedule.yaml has it on day D.3 of cluster D; " +
        "aixi (D.3.2) is in schedule.yaml but has no built MDX",
    );
  });

  it("throws when any request fails", async () => {
    const mdx = `${SITE}/downloads/aixi/aixi.mdx`;
    await expect(readSnapshot(fakeSite({ [mdx]: { status: 500 } }).fetchBytes)).rejects.toThrow(`Iliad: ${mdx} answered 500`);
    await expect(readSnapshot(fakeSite({ [SCHEDULE_URL]: undefined }).fetchBytes)).rejects.toThrow(`Iliad: ${SCHEDULE_URL} does not exist`);
  });

  it("says what is wrong with a schedule it cannot read", async () => {
    const read = (schedule: string) => readSnapshot(fakeSite({ [SCHEDULE_URL]: schedule }).fetchBytes);
    await expect(read("days: []")).rejects.toThrow("Iliad: schedule.yaml has no list of clusters");
    await expect(read("clusters:\n  - id: D\n    label: Agency")).rejects.toThrow("schedule.yaml has no urlSlug for cluster D");
    await expect(read("clusters:\n  - {id: D, label: x, urlSlug: agency, days: [{code: D.1, title: t, worksheets: [../secrets]}]}")).rejects.toThrow(
      'names a worksheet "../secrets" on day D.1, which is not a folder name',
    );
  });

  it("throws when the site is rebuilt from another commit during the read", async () => {
    let reads = 0;
    const site = fakeSite({ [`${SITE}/`]: () => home(reads++ === 0 ? COMMIT : OTHER_COMMIT) });
    await expect(readSnapshot(site.fetchBytes)).rejects.toThrow("the site was rebuilt during the read (commit d5fec17 became 46ea03c)");
  });

  it("throws when the files read were not all published by one deploy", async () => {
    // The CDN still serves this worksheet from the deploy before.
    const stale = { body: readFileSync(join(FIXTURES, "aixi.mdx"), "utf8"), lastModified: "Sun, 11 Oct 2026 15:02:41 GMT" };
    await expect(readSnapshot(fakeSite({ [`${SITE}/downloads/aixi/aixi.mdx`]: stale }).fetchBytes)).rejects.toThrow(
      "the files read come from more than one deploy of the site (2026-10-11T15:02:41Z to 2026-10-11T16:13:08Z)",
    );
    // One deploy stamps its files a second or so apart.
    const sameDeploy = { ...stale, lastModified: "Sun, 11 Oct 2026 16:13:07 GMT" };
    expect((await readSnapshot(fakeSite({ [`${SITE}/downloads/aixi/aixi.mdx`]: sameDeploy }).fetchBytes)).worksheets).toHaveLength(5);
  });

  it("fails when only some files carry Last-Modified: the check would cover a part of the read", async () => {
    // A deploy caught half way: this worksheet is the CDN's copy of the deploy before, and it came with no stamp.
    const unstamped = { body: readFileSync(join(FIXTURES, "aixi.mdx"), "utf8"), lastModified: null };
    await expect(readSnapshot(fakeSite({ [`${SITE}/downloads/aixi/aixi.mdx`]: unstamped }).fetchBytes)).rejects.toThrow(
      "Iliad snapshot at d5fec17 is inconsistent: 1 of the 7 files read came without a Last-Modified header, so it cannot be checked that all are from one deploy",
    );
  });

  it("says so when no file carries Last-Modified: the snapshot is read, and the check did not run", async () => {
    const site = fakeSite();
    const bare: typeof site.fetchBytes = async (url, opts) => ({ ...(await site.fetchBytes(url, opts)), headers: new Headers() });
    const snapshot = await readSnapshot(bare);
    expect(snapshot.worksheets).toHaveLength(5);
    expect(snapshot.warnings).toEqual([
      "https://iliad-intensive.org sent no Last-Modified header, so it was not checked that every file read is from one deploy of the site",
    ]);
    // Its figures cannot be checked either.
    expect((await snapshot.asset("/uploads/aixi/roadmap.svg")).byteLength).toBeGreaterThan(0);
    // With the header on every file, there is nothing to warn of.
    expect((await readSnapshot(site.fetchBytes)).warnings).toEqual([]);
  });

  it("fetches a figure by site path, from this site and this deploy only", async () => {
    const figure = `${SITE}/uploads/aixi/roadmap.svg`;
    const snapshot = await readSnapshot(fakeSite().fetchBytes);
    expect(new TextDecoder().decode(await snapshot.asset("/uploads/aixi/roadmap.svg"))).toContain("<svg");

    const unstamped = await readSnapshot(fakeSite({ [figure]: { body: "<svg/>", lastModified: null } }).fetchBytes);
    await expect(unstamped.asset("/uploads/aixi/roadmap.svg")).rejects.toThrow(
      "/uploads/aixi/roadmap.svg came without a Last-Modified header, so it cannot be checked that it is from the deploy of the snapshot",
    );
    const redeployed = await readSnapshot(fakeSite({ [figure]: { body: "<svg/>", lastModified: "Sun, 11 Oct 2026 17:40:00 GMT" } }).fetchBytes);
    await expect(redeployed.asset("/uploads/aixi/roadmap.svg")).rejects.toThrow(
      "/uploads/aixi/roadmap.svg comes from another deploy of the site (2026-10-11T17:40:00Z) than the snapshot (2026-10-11T16:13:08Z)",
    );
  });

  it("fails the run for a figure only when the failure can pass by itself", async () => {
    const figure = `${SITE}/uploads/aixi/roadmap.svg`;
    /** How fetching the figure fails, given what the site does: "passing" fails the run, "permanent" makes a link of it. */
    const outcome = async (served: Served | undefined, fetchFails?: string) => {
      const site = fakeSite({ [figure]: served });
      const fetchBytes: FetchBytes = async (url, opts) => {
        if (fetchFails && url === figure) throw new Error(fetchFails);
        return site.fetchBytes(url, opts);
      };
      const error = await (await readSnapshot(fetchBytes)).asset("/uploads/aixi/roadmap.svg").then(
        () => null,
        (err: Error) => err,
      );
      return error && [error instanceof PermanentImageError ? "permanent" : "passing", error.message];
    };

    // Until Iliad changes the figure: the lens links to it, and the run goes on with every other worksheet.
    expect(await outcome(undefined)).toEqual(["permanent", `Iliad: ${figure} answered 404`]);
    expect(await outcome({ status: 403 })).toEqual(["permanent", `Iliad: ${figure} answered 403`]);
    expect(await outcome("<svg/>", "Response too large: >31457280 bytes")).toEqual(["permanent", `Iliad: ${figure}: Response too large: >31457280 bytes`]);
    // These pass by themselves: the run fails, and the next one tries again.
    expect(await outcome({ status: 503 })).toEqual(["passing", `Iliad: ${figure} answered 503`]);
    expect(await outcome({ status: 429 })).toEqual(["passing", `Iliad: ${figure} answered 429`]);
    expect(await outcome("<svg/>", "fetch failed")).toEqual(["passing", `Iliad: ${figure}: fetch failed`]);
    expect(await outcome({ body: "<svg/>", lastModified: "Sun, 11 Oct 2026 17:40:00 GMT" })).toEqual([
      "passing",
      "Iliad: /uploads/aixi/roadmap.svg comes from another deploy of the site (2026-10-11T17:40:00Z) than the snapshot (2026-10-11T16:13:08Z)",
    ]);

    const snapshot = await readSnapshot(fakeSite().fetchBytes);
    for (const elsewhere of ["//evil.test/x.svg", "https://evil.test/x.svg"]) {
      const error = await snapshot.asset(elsewhere).catch((err: Error) => err);
      expect(error).toBeInstanceOf(PermanentImageError);
      expect((error as Error).message).toBe(`Iliad: ${elsewhere} is not a path on https://iliad-intensive.org`);
    }
  });

  it("says when the site was deployed: the Last-Modified of its pages", async () => {
    expect((await readSnapshot(fakeSite().fetchBytes)).deployedAt).toEqual(new Date("2026-10-11T16:13:08Z"));
    const site = fakeSite();
    const bare: FetchBytes = async (url, opts) => ({ ...(await site.fetchBytes(url, opts)), headers: new Headers() });
    expect((await readSnapshot(bare)).deployedAt).toBeNull();
  });
});

describe("snapshotFromDir", () => {
  it("reads the same worksheets from a directory", async () => {
    const fromSite = await readSnapshot(fakeSite().fetchBytes);
    const fromDir = await snapshotFromDir(FIXTURES, COMMIT);
    expect(fromDir.commit).toBe(COMMIT);
    expect(fromDir.worksheets).toEqual(fromSite.worksheets);
    expect(fromDir.warnings).toEqual([]);
    expect((await snapshotFromDir(FIXTURES)).commit).toBe("local");
    // When the newest of its files was changed.
    const newest = Math.max(...["schedule.yaml", ...readdirSync(FIXTURES).filter((n) => n.endsWith(".mdx") && n !== "example.mdx")].map((n) => statSync(join(FIXTURES, n)).mtimeMs));
    expect(fromDir.deployedAt).toEqual(new Date(newest));
  });

  it("reads a figure from the directory and nothing outside it", async () => {
    const snapshot = await snapshotFromDir(FIXTURES);
    expect(new TextDecoder().decode(await snapshot.asset("/uploads/aixi/roadmap.svg"))).toContain("<svg");
    for (const missing of ["/uploads/aixi/gone.svg", "/../snapshot.ts"]) {
      const error = await snapshot.asset(missing).catch((err: Error) => err);
      // As on the site: a link in the lens, and the run goes on.
      expect(error).toBeInstanceOf(PermanentImageError);
      expect((error as Error).message).toMatch(new RegExp(`^Iliad: ${missing.replace(/[./]/g, "\\$&")} is not a file in `));
    }
  });

  it("is all or nothing too", async () => {
    await expect(snapshotFromDir(join(FIXTURES, "uploads"))).rejects.toThrow("has no schedule.yaml");
  });
});

// Reads the real site: `ILIAD_LIVE=1 npx vitest run server/source-sync/iliad/snapshot.test.ts`.
describe.skipIf(!process.env.ILIAD_LIVE)("the live site", () => {
  it("publishes 28 worksheets", async () => {
    const started = Date.now();
    const commit = await publishedCommit();
    const polled = Date.now();
    const snapshot = await readSnapshot();
    console.log(`publishedCommit ${polled - started} ms, readSnapshot ${Date.now() - polled} ms, commit ${snapshot.commit}`);

    expect(snapshot.commit).toBe(commit);
    expect(snapshot.worksheets).toHaveLength(28);
    expect(snapshot.worksheets.map((w) => w.code).slice(0, 3)).toEqual(["0", "A.1", "A.2"]);
    expect(snapshot.worksheets.find((w) => w.slug === "aixi")).toMatchObject({ code: "D.3.2", pageUrl: `${SITE}/agency/aixi/` });
    expect(snapshot.worksheets.every((w) => w.mdx.length > 500 && !w.mdx.startsWith("---"))).toBe(true);

    const figure = /<Figure src="(\/uploads\/[^"]+)"/.exec(snapshot.worksheets.map((w) => w.mdx).join("\n"))![1];
    expect((await snapshot.asset(figure)).byteLength).toBeGreaterThan(1000);
  }, 120_000);
});
