# Article review pipeline

Full article imports now use one mandatory, fail-closed review pipeline. Stubs are exempt.

1. Fetch the source with the importer's SSRF-safe adapters. PDFs retain their original bytes; every HTML page is rendered through Jina before extraction, while the direct response remains as unrendered provenance.
2. Extract Markdown deterministically and prepare hosted images.
3. Apply syntax-aware, idempotent, source-preserving normalizations. Code,
   comments, CriticMarkup, and math are opaque to these repairs.
4. Send the complete draft to Lens Platform's `/api/content/validate-article` endpoint.
5. Run Claude Sonnet against local source evidence, the draft, and Platform findings. Claude has only `Read,Edit`; it edits the candidate directly and cannot fetch, run commands, create files, or delegate. It decides whether clearly terminal Acknowledgements, References, or standalone series navigation should be wrapped in `:::collapse`; substantive sections, appendices, footnotes, and following prose stay open.
6. Programmatically protect pipeline-owned metadata and authoring comments, regenerate metadata, and validate again. Up to two additional repair rounds are allowed.
7. Stamp review provenance, validate the exact final file, then write it to Relay.

Any missing validator configuration, Platform outage, Claude failure/timeout, inaccessible source, rejected review, unsafe patch, or remaining validation error prevents the article write. Warnings remain review context and do not block a reviewed draft. PDF figure upload failure also blocks; arXiv image-hosting failure retains the original external image.

The lens-editor container needs `LENS_PLATFORM_URL`, `ADHOC_VALIDATION_SECRET`, and `JINA_API_KEY`. The validation secret must match Lens Platform. Article jobs default to 25 minutes and may be overridden with `ARTICLE_JOB_TIMEOUT_MS`.

For HTML evidence, `source-unrendered.html` is the direct response and
`source-rendered.html` is the line-bounded Jina result used for extraction and
review. `source.txt` is derived from that result or authoritative native
Markdown supplied by an adapter. HTML imports fail
closed when rendering fails; PDFs do not use Jina.

Before enabling full imports, copy the same `ADHOC_VALIDATION_SECRET` used by
the Platform endpoint into the production lens-relay `.env`, recreate the
lens-editor container, and run an authenticated server-to-server smoke test:

```bash
ssh relay-prod 'cd /root/lens-relay && set -a && . ./.env && set +a && \
  test -n "$ADHOC_VALIDATION_SECRET" && \
  curl --fail-with-body --silent --show-error \
    -H "Content-Type: application/json" \
    -H "X-Validation-Key: $ADHOC_VALIDATION_SECRET" \
    --data '"'"'{"path":"articles/smoke-test.md","content":"---\\ntitle: Smoke Test\\nauthor:\\n  - Lens Academy\\nsource_url: https://example.com/smoke-test\\npublished: 2026-08-24\\ncreated: 2026-08-24\\ntags:\\n  - article\\n---\\n\\nAuthenticated validation smoke test.\\n"}'"'"' \
    "${LENS_PLATFORM_URL%/}/api/content/validate-article"'
```

The response must be authenticated JSON in the validator result shape. A
validation error for the deliberately minimal content is acceptable; HTTP
401/403, malformed JSON, or an unreachable endpoint is not. Keep full imports
disabled until this succeeds.

## Online troubleshooting reports

Every queued production import writes a versioned JSON report under
`/data/lens-editor/article-review-reports/YYYY-MM-DD/<job-id>-<report-uuid>/report.json`,
persisted on the host at `/root/lens-editor-data/article-review-reports`. Each
job has an isolated directory, and each atomic snapshot uses a unique temporary
filename, so the three parallel Claude sessions never share a report or temp
file. Report persistence is a hard gate: a write failure fails the import.

The exact Markdown sent to Relay is stored beside the report as `final.md`,
with its byte count in `report.json`. This provides the original imported
baseline.

Reports retain stage timings, extraction identity, bounded programmatic
before/after evidence, all validator rounds, LLM findings and patches, final
outcome, and the classifications `programmatic-fix`,
`validator-detected-llm-fixed`, and `llm-detected-llm-fixed`. They never contain
secrets or complete source captures. The lifecycle summary explicitly records
validator findings fixed by the LLM, remaining or newly introduced findings,
independent LLM repairs, and LLM findings that were not repaired. Structured
findings from rejected LLM reviews are retained too. Reports and `final.md`
are retained for 90 days; bounded evidence excerpts are removed after 30 days
while their lengths remain available for trend analysis.

Before deploying, create the host directory and make it writable by the
lens-editor container. Summarize recurring findings with:

```bash
cd lens-editor
npm run article-review -- summarize-reports \
  --report-root /root/lens-editor-data/article-review-reports \
  --since 2026-08-01
```

## Retroactive review

The local CLI reuses the same fetchers, evidence format, and direct-edit LLM reviewer. It prepares independent bundles and publishes reviewed differences as Relay CriticMarkup suggestions:

```bash
cd lens-editor
RELAY_URL=https://relay.lensacademy.org MCP_API_KEY=... \
  npm run article-review -- prepare --content-root /path/to/lens-edu --all
RELAY_URL=https://relay.lensacademy.org MCP_API_KEY=... \
  npm run article-review -- prepare --content-root /path/to/lens-edu --manifest articles.json
RELAY_URL=https://relay.lensacademy.org MCP_API_KEY=... \
  npm run article-review -- execute --run .article-review-cache/<run-id> --article articles/example.md
RELAY_URL=https://relay.lensacademy.org MCP_API_KEY=... \
  npm run article-review -- execute --run .article-review-cache/<run-id> --all --provider codex
npm run article-review -- status --run .article-review-cache/<run-id>
npm run article-review -- prune --days 30
```

Preparation uses the local checkout only to select article paths. It reads each
`article.md` from Relay through the authenticated, read-only MCP `read` tool, so
the bundle contains the current accepted CriticMarkup view; source fetching and
extraction still run locally. `MCP_API_KEY` may instead be supplied as
`ARTICLE_REVIEW_RELAY_TOKEN`. Each run records batches of at most five articles.
The executor confirms that Relay's accepted view still matches the bundle,
runs the same reviewer as a live import, validates the clean result, publishes
the exact diff through Relay MCP, and validates again with
`accept_drafts: true`. Local content files are selection inputs only; all content changes go
through Relay as reviewable CriticMarkup.

Retroactive runs default to Claude (`sonnet`). Local operators can select
`--provider codex`, which defaults to `gpt-5.6-terra`, or override either
provider's model with `--model`. Codex runs ephemerally in an isolated copy of
the review bundle with local read/edit access and no network access. The live
import pipeline remains explicitly Claude-only.

Long retroactive Claude reviews can raise the local per-article guard with
`--max-budget-usd` or extend the local timeout with `--timeout-minutes`; the
live-import defaults remain unchanged.

On Ubuntu 24.04, install and load `docs/codex-bwrap.apparmor` as
`/etc/apparmor.d/codex-bwrap` so Codex's bundled bubblewrap can create the
user and network namespaces required by its sandbox. This grants namespace
access only to the system bubblewrap executable and Codex's versioned fallback;
do not disable Ubuntu's system-wide unprivileged-user-namespace restriction.

Review provenance is written as one nested mapping, following the eval-results
frontmatter convention:

```yaml
llm-review:
  date: 2026-08-19
  model: "sonnet"
  version: "article-qc-v1.1"
  source:
    fetched: 2026-08-19
    kind: "live"
```

Lens Platform currently permits legacy articles with no review provenance and
continues to accept complete legacy flat stamps. Once either representation is
started, all fields in that representation are required
(`article.llm-review-incomplete`). After the backfill is complete, requiring
provenance on every full article is the final migration gate.
