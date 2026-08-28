import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ArticleReviewProvider } from "../server/add-article/claude";

export type ReviewItemState = "prepared" | "running" | "suggested" | "reviewed" | "failed";

export interface ReviewItem {
  article_path: string;
  relay_path: string;
  source_url: string;
  bundle: string;
  state: ReviewItemState;
  error?: string;
  review_provider?: ArticleReviewProvider;
  review_model?: string;
  started_at?: string;
}

export interface ReviewRun {
  version: 1;
  run_id: string;
  created_at: string;
  content_root: string;
  items: ReviewItem[];
  batches: string[][];
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const CLAIM_STALE_MS = 15 * 60_000;

export function reviewItemCanBeClaimed(item: ReviewItem, now = Date.now()): boolean {
  if (item.state === "prepared") return true;
  if (item.state !== "running" || !item.started_at) return false;
  const startedAt = Date.parse(item.started_at);
  return !Number.isFinite(startedAt) || now - startedAt > CLAIM_STALE_MS;
}

export async function readReviewRun(runDir: string): Promise<ReviewRun> {
  return JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf-8")) as ReviewRun;
}

async function atomicWriteRun(runDir: string, run: ReviewRun): Promise<void> {
  const manifestPath = path.join(runDir, "manifest.json");
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(run, null, 2));
  await fs.rename(temporary, manifestPath);
}

async function withManifestLock<T>(runDir: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(runDir, ".manifest.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for article-review manifest lock: ${lockPath}`);
      await delay(50);
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export async function writeReviewRun(runDir: string, run: ReviewRun): Promise<void> {
  await withManifestLock(runDir, () => atomicWriteRun(runDir, run));
}

export async function claimReviewItem(
  runDir: string,
  articlePath: string,
  provider: ArticleReviewProvider,
  model: string,
): Promise<ReviewItem | null> {
  return withManifestLock(runDir, async () => {
    const run = await readReviewRun(runDir);
    const item = run.items.find((candidate) => candidate.article_path === articlePath);
    if (!item || !reviewItemCanBeClaimed(item)) return null;
    item.state = "running";
    item.review_provider = provider;
    item.review_model = model;
    item.started_at = new Date().toISOString();
    delete item.error;
    await atomicWriteRun(runDir, run);
    return { ...item };
  });
}

export async function finishReviewItem(
  runDir: string,
  articlePath: string,
  state: "suggested" | "failed",
  error?: string,
): Promise<void> {
  await withManifestLock(runDir, async () => {
    const run = await readReviewRun(runDir);
    const item = run.items.find((candidate) => candidate.article_path === articlePath);
    if (!item) throw new Error(`Article is missing from review manifest: ${articlePath}`);
    item.state = state;
    if (error) item.error = error;
    else delete item.error;
    delete item.started_at;
    await atomicWriteRun(runDir, run);
  });
}
