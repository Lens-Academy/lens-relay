import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
const selector = path.resolve("server/add-article/select-review-base.mjs");

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) =>
    fs.rm(entry, { recursive: true, force: true })));
});

async function fixture(): Promise<{ workDir: string; env: NodeJS.ProcessEnv }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "article-base-selection-"));
  temporaryPaths.push(workDir);
  await fs.writeFile(path.join(workDir, "candidate-rendered.md"), "rendered candidate\n");
  await fs.writeFile(path.join(workDir, "candidate-unrendered.md"), "unrendered candidate\n");
  const renderedValidation = path.join(workDir, ".rendered-validator-input.json");
  const unrenderedValidation = path.join(workDir, ".unrendered-validator-input.json");
  await fs.writeFile(renderedValidation, '[{"code":"rendered"}]');
  await fs.writeFile(unrenderedValidation, '[{"code":"unrendered"}]');
  return {
    workDir,
    env: {
      ...process.env,
      ARTICLE_REVIEW_RENDERED_VALIDATION_PATH: renderedValidation,
      ARTICLE_REVIEW_UNRENDERED_VALIDATION_PATH: unrenderedValidation,
    },
  };
}

describe("review base selector", () => {
  it.each(["rendered", "unrendered"] as const)(
    "copies the %s candidate byte-for-byte and records the choice",
    async (base) => {
      const { workDir, env } = await fixture();
      await expect(fs.stat(path.join(workDir, "validation.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(workDir, "validation-rendered.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(workDir, "validation-unrendered.json"))).rejects.toThrow();
      await execFileAsync(process.execPath, [selector, base], { cwd: workDir, env });
      expect(await fs.readFile(path.join(workDir, "article.md"), "utf-8"))
        .toBe(`${base} candidate\n`);
      expect(JSON.parse(await fs.readFile(path.join(workDir, ".base-selection.json"), "utf-8")))
        .toEqual({ base });
      expect(JSON.parse(await fs.readFile(path.join(workDir, "validation.json"), "utf-8")))
        .toEqual([{ code: base }]);
      expect(JSON.parse(await fs.readFile(path.join(workDir, "validation-rendered.json"), "utf-8")))
        .toEqual([{ code: "rendered" }]);
      expect(JSON.parse(await fs.readFile(path.join(workDir, "validation-unrendered.json"), "utf-8")))
        .toEqual([{ code: "unrendered" }]);
    },
  );

  it("rejects invalid and repeated selections", async () => {
    const { workDir, env } = await fixture();
    await expect(execFileAsync(process.execPath, [selector, "other"], { cwd: workDir }))
      .rejects.toThrow();
    await execFileAsync(process.execPath, [selector, "rendered"], { cwd: workDir, env });
    await expect(execFileAsync(process.execPath, [selector, "unrendered"], { cwd: workDir, env }))
      .rejects.toThrow(/already been selected/);
  });
});
