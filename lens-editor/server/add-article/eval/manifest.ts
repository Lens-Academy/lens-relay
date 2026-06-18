export interface ManifestEntry {
  slug: string;
  relay_path: string;
  source_url: string;
  resolved_fetch_url: string;
  host: string;
  expected_via: string;
  needs_body_markdown: boolean;
  status: "ok" | "skipped:404" | "skipped:blocked" | "excluded:link-out";
}

export function classifyVia(sourceUrl: string): string {
  let host = "";
  try { host = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "generic"; }
  if (/(^|\.)(lesswrong\.com|alignmentforum\.org|greaterwrong\.com)$/.test(host) ||
      host === "forum.effectivealtruism.org") return "forum-adapter";
  if (/(^|\.)wikipedia\.org$/.test(host)) return "wikipedia";
  if (host === "ai-safety-atlas.com") return "ai-safety-atlas";
  if (host === "arxiv.org" || host.endsWith("ar5iv.org") || host === "ar5iv.labs.arxiv.org") return "arxiv";
  return "generic";
}

/** Round-robin by `expected_via` so scarce classes aren't starved. */
export function stratifiedSelect(entries: ManifestEntry[], target: number): ManifestEntry[] {
  const byVia = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    let arr = byVia.get(e.expected_via);
    if (!arr) byVia.set(e.expected_via, (arr = []));
    arr.push(e);
  }
  const queues = [...byVia.values()];
  const out: ManifestEntry[] = [];
  let progress = true;
  while (out.length < target && progress) {
    progress = false;
    for (const q of queues) {
      if (out.length >= target) break;
      const next = q.shift();
      if (next) { out.push(next); progress = true; }
    }
  }
  return out;
}
