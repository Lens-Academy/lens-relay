import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ArticleJob, ArticleMeta } from "./types";
import { fetchRawHtml, fetchJina, extractHtmlMeta } from "./fetch";
import { runArticleClaude } from "./claude";
import { generateArticleMarkdown, generateArticleFilenameBase } from "./export";
import {
  createRelayDoc,
  updateRelayDoc,
  checkRelayDocsExist,
} from "../add-video/relay-docs";

const WORK_BASE = "/tmp/articles";
const TIMEOUT_MS = 1_200_000; // 20 minutes
// Below this, Claude almost certainly failed silently (returned only a heading
// or the wrong section) rather than producing a real article body.
const MIN_CLEANED_CHARS = 500;

function relayArticleFolder(): string {
  return process.env.RELAY_ARTICLE_FOLDER || "Lens Edu/articles";
}

export async function processArticle(job: ArticleJob): Promise<void> {
  const workDir = path.join(WORK_BASE, job.id);
  let mdPath: string | undefined;
  let placeholderContent = "";
  // Captured once metadata is known, so the catch block can regenerate the
  // failed-state doc from structured data rather than string-matching prose.
  let seededMeta: ArticleMeta | null = null;

  try {
    console.log(`[add-article] Processing ${job.url}`);
    await fs.mkdir(workDir, { recursive: true });

    // 1. Fetch raw HTML and Jina extraction concurrently. Either may fail
    //    (paywall, bot blocking, Jina outage) — we proceed if at least one
    //    source of content is available.
    const [htmlResult, jinaResult] = await Promise.allSettled([
      fetchRawHtml(job.url),
      fetchJina(job.url),
    ]);

    const html = htmlResult.status === "fulfilled" ? htmlResult.value : null;
    const jina = jinaResult.status === "fulfilled" ? jinaResult.value : null;
    if (htmlResult.status === "rejected") {
      console.warn(`[add-article] Raw HTML fetch failed: ${htmlResult.reason}`);
    }
    if (jinaResult.status === "rejected") {
      console.warn(`[add-article] Jina fetch failed: ${jinaResult.reason}`);
    }
    if (!html && !jina) {
      throw new Error(
        `Could not fetch article: ${String(
          (htmlResult as PromiseRejectedResult).reason,
        )} / ${String((jinaResult as PromiseRejectedResult).reason)}`,
      );
    }

    // 2. Seed metadata: HTML meta tags win over Jina (more structured),
    //    Claude refines both later.
    const htmlMeta = html ? extractHtmlMeta(html) : null;
    const meta: ArticleMeta = {
      title: htmlMeta?.title || jina?.title || "",
      author: htmlMeta?.author ?? [],
      source_url: job.url,
      published: htmlMeta?.published || jina?.published || "",
      description: htmlMeta?.description ?? "",
    };
    seededMeta = meta;
    if (!meta.title) {
      throw new Error("Could not determine article title from page metadata");
    }
    job.title = meta.title;

    // 3. Resolve relay path; refuse to overwrite an existing article.
    const filenameBase = generateArticleFilenameBase(meta.author, meta.title);
    if (!filenameBase) {
      throw new Error(`Could not derive filename from title: ${meta.title}`);
    }
    mdPath = `${relayArticleFolder()}/${filenameBase}.md`;
    const editorBase =
      process.env.EDITOR_BASE_URL || "https://editor.lensacademy.org";
    job.relay_url = `${editorBase}/open/${encodeURI(mdPath)}`;
    job.updated_at = new Date().toISOString();

    const exists = await checkRelayDocsExist([mdPath]);
    if (exists[mdPath]) {
      throw new Error(`Document already exists: ${mdPath}`);
    }

    // 4. Write work files for Claude
    await fs.writeFile(
      path.join(workDir, "extracted.md"),
      jina?.markdown ?? "",
    );
    if (html) {
      await fs.writeFile(path.join(workDir, "raw.html"), html);
    }
    await fs.writeFile(
      path.join(workDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );

    // 5. Create placeholder doc so the user can follow along
    const placeholderBody = [
      `*This article is being imported from <${job.url}>.*`,
      "",
      "Content will appear here in a few minutes. Imports share a pool of 3 concurrent sessions and are processed as capacity allows.",
      "",
      `Queued at: ${new Date(job.created_at).toLocaleString()}`,
    ].join("\n");
    placeholderContent = generateArticleMarkdown(
      meta,
      placeholderBody,
      new Date().toISOString().slice(0, 10),
    );
    await createRelayDoc(mdPath, placeholderContent);

    // 6. Run Claude cleanup
    const wordCount = (jina?.markdown ?? "").split(/\s+/).length;
    console.log(
      `[add-article] Running Claude on ~${wordCount} extracted words...`,
    );
    const result = await runArticleClaude(workDir, TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(
        `Claude exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
      );
    }

    // 7. Read cleaned body + refined metadata
    const cleaned = (
      await fs.readFile(path.join(workDir, "cleaned.md"), "utf-8")
    ).trim();
    if (cleaned.length < MIN_CLEANED_CHARS) {
      throw new Error(
        `Cleaned article suspiciously short (${cleaned.length} chars) — aborting`,
      );
    }
    let finalMeta = meta;
    try {
      const refined = JSON.parse(
        await fs.readFile(path.join(workDir, "meta.json"), "utf-8"),
      );
      finalMeta = {
        title:
          typeof refined.title === "string" && refined.title
            ? refined.title
            : meta.title,
        author: Array.isArray(refined.author)
          ? refined.author.filter((a: unknown) => typeof a === "string" && a)
          : meta.author,
        source_url: job.url,
        published: /^\d{4}-\d{2}-\d{2}$/.test(refined.published)
          ? refined.published
          : meta.published,
        description:
          typeof refined.description === "string"
            ? refined.description
            : meta.description,
      };
    } catch (err) {
      console.warn(
        `[add-article] Could not parse refined meta.json, using seed metadata: ${err}`,
      );
    }
    job.title = finalMeta.title;

    // 8. Replace placeholder with the final article
    const finalMd = generateArticleMarkdown(
      finalMeta,
      cleaned,
      new Date().toISOString().slice(0, 10),
    );
    await updateRelayDoc(mdPath, placeholderContent, finalMd);
  } catch (err) {
    // If we got far enough to create a placeholder, mark it failed so the
    // doc doesn't sit there saying "being imported" forever. Regenerate from
    // the seeded metadata instead of editing the placeholder prose.
    if (mdPath && placeholderContent && seededMeta) {
      const failedBody = `*Article import failed.* You can resubmit it from the Add Article page.\n\nFailed at: ${new Date().toISOString()}`;
      const failedContent = generateArticleMarkdown(
        seededMeta,
        failedBody,
        new Date().toISOString().slice(0, 10),
      );
      await updateRelayDoc(mdPath, placeholderContent, failedContent).catch(
        () => {},
      );
    }
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true }).catch(() => {});
  }
}
