import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayCourseFiles } from "./relay-course-files";

/** The relay, as far as these calls go: answers by route, and records what it was asked. */
function relay(answers: Record<string, (body: unknown, url: URL) => Response | Promise<Response>>) {
  const requests: { method: string; route: string; auth: string | null; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const raw = init.body;
      const body = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      requests.push({ method: init.method ?? "GET", route: url.pathname, auth: new Headers(init.headers).get("authorization"), body });
      const answer = answers[url.pathname];
      if (!answer) return new Response(`no route ${url.pathname}`, { status: 404 });
      return answer(body, url);
    }),
  );
  return requests;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("relayCourseFiles", () => {
  beforeEach(() => {
    vi.stubEnv("RELAY_URL", "http://relay.test:8080");
    vi.stubEnv("RELAY_SERVER_TOKEN", "server-token");
    vi.stubEnv("RELAY_ID", "a0000000-0000-4000-8000-000000000000");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("moves a file with the relay's own move, by path within its folder", async () => {
    const requests = relay({ "/move": () => json({ old_path: "/Lenses/x.md", new_path: "/Lenses/Iliad/B.3 SLT/x.md", old_folder: "Lens Edu", new_folder: "Lens Edu", links_rewritten: 3 }) });
    await relayCourseFiles().move("Lens Edu/Lenses/x.md", "Lens Edu/Lenses/Iliad/B.3 SLT/x.md");
    expect(requests).toEqual([{ method: "POST", route: "/move", auth: "Bearer server-token", body: { path: "Lens Edu/Lenses/x.md", new_path: "/Lenses/Iliad/B.3 SLT/x.md" } }]);
  });

  it("says so when the target of a move exists, and passes on any other refusal", async () => {
    relay({ "/move": () => new Response("", { status: 409 }) });
    await expect(relayCourseFiles().move("Lens Edu/a.md", "Lens Edu/b.md")).rejects.toThrow('Relay: cannot move "Lens Edu/a.md": "Lens Edu/b.md" already exists');
    relay({ "/move": () => new Response("no such document", { status: 404 }) });
    await expect(relayCourseFiles().move("Lens Edu/a.md", "Lens Edu/b.md")).rejects.toThrow('Relay: moving "Lens Edu/a.md" to "Lens Edu/b.md" failed: 404 no such document');
    const requests = relay({});
    await expect(relayCourseFiles().move("Lens Edu/a.md", "Lens/b.md")).rejects.toThrow("not in one folder");
    expect(requests).toEqual([]);
  });

  it("trashes a file by path, never forced", async () => {
    const requests = relay({ "/doc/trash": () => json({ trashed: ["Lens Edu/_trash/Lenses/x.md"], trashed_at: 1, restore_hint: "" }) });
    await relayCourseFiles().trash("Lens Edu/Lenses/x.md");
    expect(requests).toEqual([{ method: "POST", route: "/doc/trash", auth: "Bearer server-token", body: { path: "Lens Edu/Lenses/x.md" } }]);
  });

  it("tries a refused trash again, for the seconds the relay needs to see that the module let go", async () => {
    let asked = 0;
    const refusal = { error: "still linked", code: "inbound_links", referencing: [{ path: "Lens Edu/modules/Iliad B - Learning.md", count: 1 }] };
    const requests = relay({ "/doc/trash": () => (++asked < 3 ? json(refusal, 409) : json({ trashed: [], trashed_at: 1, restore_hint: "" })) });
    await relayCourseFiles({ trashRetryMs: 1 }).trash("Lens Edu/Lenses/x.md");
    expect(requests).toHaveLength(3);
  });

  it("gives up on a trash that stays refused, naming what still links there", async () => {
    const refusal = { error: "still linked", code: "inbound_links", referencing: [{ path: "Lens Edu/modules/Other course.md", count: 1 }] };
    const requests = relay({ "/doc/trash": () => json(refusal, 409) });
    await expect(relayCourseFiles({ trashAttempts: 2, trashRetryMs: 1 }).trash("Lens Edu/Lenses/x.md")).rejects.toThrow(
      'Relay: "Lens Edu/Lenses/x.md" was not trashed, because these still link to it: Lens Edu/modules/Other course.md',
    );
    expect(requests).toHaveLength(2);
  });

  it("does not try again after any other failure", async () => {
    const requests = relay({ "/doc/trash": () => json({ error: "not found", code: "not_found" }, 404) });
    await expect(relayCourseFiles({ trashRetryMs: 1 }).trash("Lens Edu/Lenses/x.md")).rejects.toThrow('Relay: trashing "Lens Edu/Lenses/x.md" failed: 404');
    expect(requests).toHaveLength(1);
  });

  it("reads null for a path the relay does not have, and writes through upsert", async () => {
    const requests = relay({
      "/debug/resolve": () => json({ filemeta_uuid: null }),
      "/doc/upsert": () => json({ doc_id: "d", path: "Lens Edu/Lenses/x.md", created: true }),
    });
    const files = relayCourseFiles();
    expect(await files.read("Lens Edu/Lenses/x.md")).toBeNull();
    await files.write("Lens Edu/Lenses/Iliad/B.3 SLT/x.md", "content");
    expect(requests[1]).toEqual({ method: "POST", route: "/doc/upsert", auth: "Bearer server-token", body: { folder: "Lens Edu", path: "/Lenses/Iliad/B.3 SLT/x.md", content: "content" } });
  });

  it("hosts an image through the attachment import and gives the folder's public address", async () => {
    const requests = relay({
      "/doc/attachment/by-hash": () => json({ found: false }),
      "/doc/attachment": (_body, url) => json({ doc_id: "d", uuid: "u", path: `Lens Edu${url.searchParams.get("path")}`, hash: "h", created: true, overwritten: false }),
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const url = await relayCourseFiles().hostImage(png, "aixi-tikz-4dc0e19d14b9");
    expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/Lens-Academy\/lens-edu-staging\/staging\/attachments\/aixi-tikz-4dc0e19d14b9-[0-9a-f]{8}\.png$/);
    expect(requests.map((request) => request.route)).toEqual(["/doc/attachment/by-hash", "/doc/attachment"]);
  });
});
