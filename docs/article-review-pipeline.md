# Article review pipeline

Full article imports now use one mandatory, fail-closed review pipeline. Stubs are exempt.

1. Fetch the source with the importer's SSRF-safe adapters and retain raw/rendered HTML or PDF plus conservative source text.
2. Extract Markdown deterministically and prepare hosted images.
3. Apply syntax-aware, idempotent, source-preserving normalizations. Code,
   comments, CriticMarkup, and math are opaque to these repairs.
4. Send the complete draft to Lens Platform's `/api/content/validate-article` endpoint.
5. Run Claude Sonnet against local source evidence, the draft, and Platform findings. Claude has only `Read,Write`; it cannot fetch or run commands. It decides whether clearly terminal Acknowledgements, References, or standalone series navigation should be wrapped in `:::collapse`; substantive sections, appendices, footnotes, and following prose stay open.
6. Apply unique exact patches, regenerate metadata, and validate again. One additional repair round is allowed.
7. Stamp review provenance and its canonical SHA-256 digest, validate the exact final file, then write it to Relay.

Any missing validator configuration, Platform outage, Claude failure/timeout, inaccessible source, rejected review, unsafe patch, or remaining validation error prevents the article write. Warnings remain review context and do not block a reviewed draft. PDF figure upload failure also blocks; arXiv image-hosting failure retains the original external image.

The lens-editor container needs `LENS_PLATFORM_URL` and `ADHOC_VALIDATION_SECRET`. The latter must match Lens Platform. Article jobs default to 25 minutes and may be overridden with `ARTICLE_JOB_TIMEOUT_MS`.

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
with its byte count and SHA-256 digest in `report.json`. This provides the
original imported baseline even if the Relay document is edited later.

Reports retain stage timings, extraction identity, bounded programmatic
before/after evidence, all validator rounds, LLM findings and patches, final
outcome, and the classifications `programmatic-fix`,
`validator-detected-llm-fixed`, and `llm-detected-llm-fixed`. They never contain
secrets or complete source captures. The lifecycle summary explicitly records
validator findings fixed by the LLM, remaining or newly introduced findings,
independent LLM repairs, and LLM findings that were not repaired. Structured
findings from rejected LLM reviews are retained too. Reports and `final.md` are retained for 90 days;
bounded evidence excerpts are removed after 30 days while their lengths and
SHA-256 hashes remain available for trend analysis.

Before deploying, create the host directory and make it writable by the
lens-editor container. Summarize recurring findings with:

```bash
cd lens-editor
npm run article-review -- summarize-reports \
  --report-root /root/lens-editor-data/article-review-reports \
  --since 2026-08-01
```

## Retroactive review

The local CLI reuses the same fetchers and evidence format, but does not launch an LLM. It prepares independent bundles for interactive Codex/Claude agents, which read the evidence and propose fixes through Relay MCP:

```bash
cd lens-editor
RELAY_URL=https://relay.lensacademy.org MCP_API_KEY=... \
  npm run article-review -- prepare --content-root /path/to/lens-edu --all
RELAY_URL=https://relay.lensacademy.org MCP_API_KEY=... \
  npm run article-review -- prepare --content-root /path/to/lens-edu --manifest articles.json
npm run article-review -- digest --file .article-review-cache/<run-id>/<bundle>/reviewed.md
npm run article-review -- status --run .article-review-cache/<run-id>
npm run article-review -- prune --days 30
```

Preparation uses the local checkout only to select article paths. It reads each
`article.md` from Relay through the authenticated, read-only MCP `read` tool, so
the bundle contains the current accepted CriticMarkup view; source fetching and
extraction still run locally. `MCP_API_KEY` may instead be supplied as
`ARTICLE_REVIEW_RELAY_TOKEN`. Each run records batches of at most five articles.
Three parallel agents is the recommended operating point. Agents must confirm
the Relay accepted view still matches the bundle, keep `reviewed.md` synchronized
with every proposed replacement, and use `validate_content` with
`accept_drafts: true` after suggesting edits. Local content files are selection
inputs only; all content changes go through Relay MCP as reviewable CriticMarkup.

Until the deployed Relay exposes `article_review_digest`, the `digest` command
computes the same canonical accepted-draft digest locally from `reviewed.md`.
It resolves CriticMarkup, removes review fields and `%%` comments, normalizes
line endings/trailing whitespace, and hashes the complete remaining document.
If `reviewed.md` is not an exact clean mirror of the full accepted draft, do not
add provenance.

Review provenance is written as one nested mapping, following the eval-results
frontmatter convention:

```yaml
llm-review:
  content-sha: "sha256:..."
  date: 2026-08-19
  model: "sonnet"
  version: "article-qc-v1"
  source:
    content-sha: "sha256:..."
    fetched: 2026-08-19
    kind: "live"
```

The digest resolves the selected CriticMarkup view, removes this mapping (or the
legacy flat review fields) and `%%` authoring comments, normalizes line
endings/trailing whitespace, and hashes the remaining metadata plus rendered
body. Partial acceptance therefore makes the review stale instead of silently
preserving a false “reviewed” state.

Lens Platform currently permits legacy articles with no review provenance and
continues to accept complete legacy flat stamps. Once either representation is
started, all fields in that representation are required
(`article.llm-review-incomplete`). After the backfill is complete, requiring
provenance on every full article is the final migration gate.
