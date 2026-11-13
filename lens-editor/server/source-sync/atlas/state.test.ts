import { describe, expect, it } from "vitest";
import { CHAPTERS, CONFIG, emptyFiles, memoryDocs } from "./__fixtures__/course";
import { readAtlasState, readUnlisted } from "./state";
import { syncAtlasCourse } from "./sync";

const LENS = "Lens Edu/Lenses/Atlas Test/Atlas - Risks - Misuse.md";
const OTHER = "Lens Edu/Lenses/Atlas Test/Atlas - Risks - Risk Decomposition.md";
const MODULE = "Lens Edu/modules/Atlas Test/Chapter 2 - Risks.md";

async function synced() {
  const files = emptyFiles();
  await syncAtlasCourse(CONFIG, { files, docs: memoryDocs(CHAPTERS()) });
  return files;
}

describe("readAtlasState", () => {
  it("reads the course as the sync wrote it", async () => {
    const state = await readAtlasState(await synced(), CONFIG);
    expect(state.syncRules).toBe(1);
    expect(state.syncConfig).toMatch(/^[0-9a-f]{12}$/);
    expect([...state.revisions.keys()]).toHaveLength(2);
    expect(state.modules.map((m) => [m.chapterSlug, m.lenses.length])).toEqual([["capabilities", 6], ["risks", 2]]);
    expect(state.pins.find((pin) => pin.lensPath === LENS)).toMatchObject({ key: "risks#misuse", heading: "h.misu", title: "Misuse", articlePath: "Lens Edu/articles/Atlas Test/Atlas - Risks - Misuse.md" });
    expect(state.occupied.size).toBe(0);
  });

  it("is empty before the first run", async () => {
    expect(await readAtlasState(emptyFiles(), CONFIG)).toMatchObject({ pins: [], modules: [], syncRules: null, syncConfig: null });
  });

  it("leaves out lenses and modules that are not the sync's", async () => {
    const files = await synced();
    files.files.set(OTHER, "---\nid: mine\ntitle: Mine\n---\n\n#### Text\ncontent::\nMy own lens.\n");
    const state = await readAtlasState(files, CONFIG);
    expect(state.pins.map((pin) => pin.lensPath)).not.toContain(OTHER);
    expect(state.occupied).toEqual(new Set([OTHER]));
  });

  it("says so when a person added an entry to a module of the sync's, which its next write drops", async () => {
    const files = await synced();
    files.files.set(MODULE, `${files.files.get(MODULE)}\n# Lens: Extra\nsource:: [[../../Lenses/Extra reading]]\n`);
    files.files.set("Lens Edu/Lenses/Extra reading.md", "---\nid: extra\n---\n");
    const state = await readAtlasState(files, CONFIG);
    expect(state.warnings).toEqual([`The module "${MODULE}" lists "Lens Edu/Lenses/Extra reading.md", which the Atlas sync did not write. The module is the sync's, so the entry goes when the sync next writes the module.`]);
  });

  it("stops on two lenses with one id", async () => {
    const files = await synced();
    const id = /^id: (.*)$/m.exec(files.files.get(LENS)!)![1];
    files.files.set(OTHER, files.files.get(OTHER)!.replace(/^id: .*$/m, `id: ${id}`));
    await expect(readAtlasState(files, CONFIG)).rejects.toThrow(`"${OTHER}" and "${LENS}" have the same id ${id}. The sync stopped and changed nothing`);
  });

  it("stops on a listed lens that is gone or has lost its id, rather than give its section a new id", async () => {
    const files = await synced();
    const lens = files.files.get(LENS)!;
    files.files.delete(LENS);
    await expect(readAtlasState(files, CONFIG)).rejects.toThrow(`The lens "${LENS}", which the module "${MODULE}" lists, does not exist. The sync stopped and changed nothing`);
    files.files.set(LENS, lens.replace(/^id: .*\n/m, ""));
    await expect(readAtlasState(files, CONFIG)).rejects.toThrow(/has no id in its frontmatter/);
    files.files.set(LENS, lens.replace(/^title: .*$/m, "title: [broken"));
    await expect(readAtlasState(files, CONFIG)).rejects.toThrow(`"${LENS}" has frontmatter that is not valid YAML`);
  });

  it("will not take over a course file it did not write", async () => {
    const files = emptyFiles();
    files.files.set(CONFIG.course, "---\nslug: atlas\ntitle: Atlas\n---\n# Module: [[../../modules/Atlas|Atlas]]\n");
    await expect(readAtlasState(files, CONFIG)).rejects.toThrow(/exists and was not written by the Atlas sync/);
  });
});

describe("readUnlisted", () => {
  it("takes back a lens of the same section, and marks any other file at a path the course would use", async () => {
    const files = await synced();
    const lens = files.files.get(LENS)!;
    files.files.delete(CONFIG.course);
    files.files.set(OTHER, "---\nid: x\n---\nA person's lens.\n");
    const state = await readAtlasState(files, CONFIG);
    await readUnlisted(files, state, [{ path: LENS, key: "risks#misuse", heading: "h.misu" }, { path: OTHER, key: "risks#risk-decomposition", heading: "h.risk" }], []);
    expect(state.pins.map((pin) => [pin.lensPath, pin.id])).toEqual([[LENS, /^id: (.*)$/m.exec(lens)![1]]]);
    expect(state.occupied).toEqual(new Set([OTHER]));
  });
});
