import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

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

async function connect(workDir: string, env: NodeJS.ProcessEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [selector],
    cwd: workDir,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stderr: "pipe",
  });
  const client = new Client({ name: "article-review-selector-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("review base selector", () => {
  it.each(["rendered", "unrendered"] as const)(
    "copies the %s candidate byte-for-byte and records the choice",
    async (base) => {
      const { workDir, env } = await fixture();
      await expect(fs.stat(path.join(workDir, "validation.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(workDir, "validation-rendered.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(workDir, "validation-unrendered.json"))).rejects.toThrow();
      const { client, transport } = await connect(workDir, env);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(["select_review_base"]);
      const result = await client.callTool({ name: "select_review_base", arguments: { base } });
      expect(result.isError).not.toBe(true);
      await transport.close();
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
    const { client, transport } = await connect(workDir, env);
    const invalid = await client.callTool({
      name: "select_review_base",
      arguments: { base: "other" },
    });
    expect(invalid.isError).toBe(true);
    const selected = await client.callTool({
      name: "select_review_base",
      arguments: { base: "rendered" },
    });
    expect(selected.isError).not.toBe(true);
    const repeated = await client.callTool({
      name: "select_review_base",
      arguments: { base: "unrendered" },
    });
    expect(repeated.isError).toBe(true);
    expect(JSON.stringify(repeated.content)).toContain("already been selected");
    await transport.close();
  });

  it("does not accept paths, commands, or any other selector inputs", async () => {
    const { workDir, env } = await fixture();
    const { client, transport } = await connect(workDir, env);
    const result = await client.callTool({
      name: "select_review_base",
      arguments: { base: "rendered", path: "/tmp/elsewhere", command: "touch escaped" },
    });
    expect(result.isError).toBe(true);
    await expect(fs.stat(path.join(workDir, "article.md"))).rejects.toThrow();
    await transport.close();
  });
});
