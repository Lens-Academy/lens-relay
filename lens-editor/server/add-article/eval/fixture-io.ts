import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const GZIP_THRESHOLD = 1024 * 1024;
const FIXTURES_ROOT = path.join(import.meta.dirname, "fixtures");

export function fixtureDir(slug: string, root: string = FIXTURES_ROOT): string {
  return path.join(root, slug);
}

export async function writeFixture(
  slug: string,
  files: { renderedSourceHtml: string; expectedMd: string; meta: object; bodyMarkdown?: string },
  root: string = FIXTURES_ROOT,
): Promise<void> {
  const dir = fixtureDir(slug, root);
  await fs.mkdir(dir, { recursive: true });
  const htmlBuf = Buffer.from(files.renderedSourceHtml, "utf-8");
  if (htmlBuf.byteLength > GZIP_THRESHOLD) {
    await fs.writeFile(path.join(dir, "renderedSource.html.gz"), await gzip(htmlBuf));
  } else {
    await fs.writeFile(path.join(dir, "renderedSource.html"), htmlBuf);
  }
  await fs.writeFile(path.join(dir, "expected.md"), files.expectedMd);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(files.meta, null, 2));
  if (files.bodyMarkdown != null) {
    await fs.writeFile(path.join(dir, "bodyMarkdown.txt"), files.bodyMarkdown);
  }
}

async function readMaybeGz(dir: string): Promise<string> {
  try { return await fs.readFile(path.join(dir, "renderedSource.html"), "utf-8"); }
  catch { return (await gunzip(await fs.readFile(path.join(dir, "renderedSource.html.gz")))).toString("utf-8"); }
}

export async function readFixture(slug: string, root: string = FIXTURES_ROOT) {
  const dir = fixtureDir(slug, root);
  const [html, expectedMd, metaRaw] = await Promise.all([
    readMaybeGz(dir),
    fs.readFile(path.join(dir, "expected.md"), "utf-8"),
    fs.readFile(path.join(dir, "meta.json"), "utf-8"),
  ]);
  let bodyMarkdown: string | undefined;
  try { bodyMarkdown = await fs.readFile(path.join(dir, "bodyMarkdown.txt"), "utf-8"); } catch { /* none */ }
  return { html, expectedMd, meta: JSON.parse(metaRaw), bodyMarkdown };
}

export function makeOfflineFetchText(expectedUrl: string, bodyMarkdown: string) {
  return async (u: string): Promise<string> => {
    if (u === expectedUrl) return bodyMarkdown;
    throw new Error(`offline fetchText: unexpected url ${u}`);
  };
}
