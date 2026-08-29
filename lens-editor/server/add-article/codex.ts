import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { baseSelectorMcpConfig, buildVerifyPrompt } from "./claude";

export const DEFAULT_CODEX_REVIEW_MODEL = "gpt-5.6-terra";

export function buildCodexVerifyPrompt(
  workDir: string,
  repairRound = 0,
  requiresBaseSelection = false,
): string {
  return buildVerifyPrompt(workDir, repairRound, requiresBaseSelection)
    .replaceAll(
      "edit article.md in place",
      "edit article.md in place with apply_patch",
    )
    .replaceAll(
      "Edit article.md in place",
      "Edit article.md in place with apply_patch",
    );
}

export function buildCodexArgs(
  workDir: string,
  statusPath: string,
  model = DEFAULT_CODEX_REVIEW_MODEL,
  repairRound = 0,
  requiresBaseSelection = false,
): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-C",
    workDir,
    "--model",
    model,
    "--output-last-message",
    statusPath,
  ];
  if (requiresBaseSelection) {
    const selector = JSON.parse(baseSelectorMcpConfig()).mcpServers.article_review;
    args.push(
      "-c",
      `mcp_servers.article_review.command=${JSON.stringify(selector.command)}`,
      "-c",
      `mcp_servers.article_review.args=${JSON.stringify(selector.args)}`,
    );
  }
  args.push(buildCodexVerifyPrompt(workDir, repairRound, requiresBaseSelection));
  return args;
}

export function parseCodexReviewStatus(output: string): "PASS" | `REJECT: ${string}` {
  const finalLine = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (finalLine === "PASS") return "PASS";
  if (/^REJECT:\s*\S/.test(finalLine)) return finalLine as `REJECT: ${string}`;
  throw new Error("Codex review must end with exactly PASS or REJECT: reason");
}

function spawnCodex(
  workDir: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  envOverride?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const binary = process.env.ARTICLE_REVIEW_CODEX_BIN ?? "codex";
    const proc = spawn(binary, args, {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: envOverride ? { ...process.env, ...envOverride } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminateGroup = () => {
      if (process.platform !== "win32" && proc.pid) {
        try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
        killTimer = setTimeout(() => {
          try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already exited */ }
        }, 5_000);
        killTimer.unref();
      } else {
        proc.kill("SIGTERM");
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      terminateGroup();
      finish(() => reject(signal?.reason ?? new Error("Codex review aborted")));
    };
    const timeout = setTimeout(() => {
      terminateGroup();
      finish(() => reject(new Error(`Codex timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => finish(() => resolve({ exitCode: code ?? 1, stdout, stderr })));
    proc.on("error", (error) => finish(() => reject(error)));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run Codex in an isolated copy, then copy back only the reviewed article. */
export async function runCodexArticleVerify(
  sourceWorkDir: string,
  repairRound: number,
  timeoutMs: number,
  model: string,
  signal?: AbortSignal,
  requiresBaseSelection = false,
  selectorEnv?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-article-codex-"));
  const statusPath = path.join(workDir, ".review-status.txt");
  try {
    if (requiresBaseSelection) {
      await Promise.all([
        fs.copyFile(path.join(sourceWorkDir, "candidate-rendered.md"), path.join(workDir, "candidate-rendered.md")),
        fs.copyFile(path.join(sourceWorkDir, "candidate-unrendered.md"), path.join(workDir, "candidate-unrendered.md")),
      ]);
    } else {
      await fs.copyFile(path.join(sourceWorkDir, "article.md"), path.join(workDir, "article.md"));
      await fs.copyFile(path.join(sourceWorkDir, "validation.json"), path.join(workDir, "validation.json"));
    }
    await fs.cp(path.join(sourceWorkDir, "evidence"), path.join(workDir, "evidence"), { recursive: true });
    const result = await spawnCodex(
      workDir,
      buildCodexArgs(workDir, statusPath, model, repairRound, requiresBaseSelection),
      timeoutMs,
      signal,
      selectorEnv,
    );
    if (result.stderr.includes("sandbox uses bubblewrap and needs access to create user namespaces")) {
      throw new Error(
        "Codex workspace sandbox is unavailable: this Linux host does not permit the user namespaces required by bubblewrap",
      );
    }
    if (result.exitCode !== 0) return result;
    const status = await fs.readFile(statusPath, "utf-8").catch(() => "");
    parseCodexReviewStatus(status);
    await fs.copyFile(path.join(workDir, "article.md"), path.join(sourceWorkDir, "article.md"));
    if (requiresBaseSelection) {
      const selection = await fs.readFile(path.join(workDir, ".base-selection.json")).catch(() => null);
      if (selection) {
        await fs.writeFile(path.join(sourceWorkDir, ".base-selection.json"), selection);
      }
      const validation = await fs.readFile(path.join(workDir, "validation.json")).catch(() => null);
      if (validation) {
        await fs.writeFile(path.join(sourceWorkDir, "validation.json"), validation);
      }
      for (const filename of ["validation-rendered.json", "validation-unrendered.json"]) {
        const candidateValidation = await fs.readFile(path.join(workDir, filename)).catch(() => null);
        if (candidateValidation) {
          await fs.writeFile(path.join(sourceWorkDir, filename), candidateValidation);
        }
      }
    }
    return { ...result, stdout: status };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
