import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINI, MINI_FLAT, MINI_FOLDERS, sameAsNow, WORKSHEETS } from "./__fixtures__/files/course";
import { applyFilePlan, planCourseFiles } from "./course-files";
import { readCourseState } from "./course-state";
import { dirCourseFiles } from "./dir-course-files";
import type { CourseFiles } from "./types";

describe("dirCourseFiles", () => {
  let root: string;
  let files: CourseFiles;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iliad-dir-"));
    files = dirCourseFiles(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads and writes files of the folder, making directories as needed", async () => {
    expect(await files.read("Lens Edu/Lenses/Iliad/B.3 SLT/x.md")).toBeNull();
    await files.write("Lens Edu/Lenses/Iliad/B.3 SLT/x.md", "one");
    expect(readFileSync(join(root, "Lenses/Iliad/B.3 SLT/x.md"), "utf8")).toBe("one");
    expect(await files.read("Lens Edu/Lenses/Iliad/B.3 SLT/x.md")).toBe("one");
  });

  it("refuses a path outside the folder", async () => {
    await expect(files.read("Lens/Notes/x.md")).rejects.toThrow('"Lens/Notes/x.md" is not a file of "Lens Edu"');
    await expect(files.write("Lens Edu/../x.md", "")).rejects.toThrow("is not a file of");
    await expect(files.move("Lens Edu/a.md", "/etc/passwd")).rejects.toThrow("is not a file of");
  });

  it("moves a file, and not onto another", async () => {
    await files.write("Lens Edu/Lenses/a.md", "a");
    await files.write("Lens Edu/Lenses/b.md", "b");
    await expect(files.move("Lens Edu/Lenses/a.md", "Lens Edu/Lenses/b.md")).rejects.toThrow('"Lens Edu/Lenses/b.md" already exists');
    await files.move("Lens Edu/Lenses/a.md", "Lens Edu/Lenses/Iliad/A.1 Intro/a.md");
    expect(await files.read("Lens Edu/Lenses/a.md")).toBeNull();
    expect(await files.read("Lens Edu/Lenses/Iliad/A.1 Intro/a.md")).toBe("a");
  });

  it("trashes to _trash under the same path, beside what is there already", async () => {
    for (const content of ["first", "second"]) {
      await files.write("Lens Edu/Lenses/Iliad/A.1 Intro/a.md", content);
      await files.trash("Lens Edu/Lenses/Iliad/A.1 Intro/a.md");
    }
    expect(existsSync(join(root, "Lenses/Iliad/A.1 Intro/a.md"))).toBe(false);
    expect(readFileSync(join(root, "_trash/Lenses/Iliad/A.1 Intro/a.md"), "utf8")).toBe("first");
    expect(readFileSync(join(root, "_trash/Lenses/Iliad/A.1 Intro/a 2.md"), "utf8")).toBe("second");
  });

  it("hosts an image under its stem and content hash", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const url = await files.hostImage(png, "aixi-tikz");
    expect(url).toMatch(/^attachments\/aixi-tikz-[0-9a-f]{8}\.png$/);
    expect(new Uint8Array(readFileSync(join(root, url)))).toEqual(png);
    expect(await files.hostImage(png, "aixi-tikz")).toBe(url);
    expect(await files.hostImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "figure")).toMatch(/^attachments\/figure-[0-9a-f]{8}\.svg$/);
  });

  it("carries a whole run: the course moved into folders on disk", async () => {
    for (const [path, content] of Object.entries(MINI)) await files.write(path, content);
    const state = await readCourseState(files, MINI_FLAT);
    const report = await applyFilePlan(files, planCourseFiles(state, sameAsNow(state, WORKSHEETS(), "c1"), { layout: MINI_FOLDERS }));
    expect(report.moved).toHaveLength(6 + 3);
    expect(existsSync(join(root, "Lenses/Iliad/B.3 SLT/Iliad B.3.1 - Introduction.md"))).toBe(true);
    expect(existsSync(join(root, "Lenses/Iliad B.3.1 - Introduction.md"))).toBe(false);
    expect(existsSync(join(root, "Lenses/cev.md"))).toBe(true);
    const moved = await readCourseState(files, MINI_FOLDERS);
    expect(moved.commit).toBe("c1");
    expect(moved.lenses.map((lens) => lens.id)).toEqual(state.lenses.map((lens) => lens.id));
  });
});
