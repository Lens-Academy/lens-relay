# Article Audit → Validator Handoff

**Date:** 2026-08-19  
**Target repository:** Lens Platform, `content_processor` article validator  
**Evidence:** Source-comparison audit of 30 stratified Lens Relay articles

## Purpose

The audit found a mixture of deterministic conversion defects and genuinely
semantic/source-fidelity defects. This document identifies which findings
should become programmatic checks, gives proposed stable codes and fixtures,
and keeps source-aware or LLM-only checks out of the offline validator.

The sample covered the dominant `ifanyonebuildsit.com` source, AI Safety Atlas,
LessWrong/Alignment Forum/EA Forum, arXiv/PDF imports, and diverse long or
feature-heavy articles. The auditors issued 50 Relay suggestions across 18 of
30 files. Several suggestions merely flagged a document for re-import rather
than attempting an unsafe reconstruction.

## Implementation boundary

The Platform validator remains offline and deterministic. It receives only the
logical article path and complete Markdown draft. It must not fetch
`source_url`, follow redirects, or infer missing source content.

Use three layers:

1. **Offline Platform validator:** syntax, renderer behavior, and high-signal
   converter residue visible in the Markdown itself.
2. **Deterministic importer checks:** facts available while fetching the source,
   such as canonical URL and structured author/date metadata.
3. **LLM source-comparison checker:** completeness, paraphrase detection,
   semantic reconstruction, and ambiguous metadata.

## Recommended offline validator work

### 1. Root-relative external links

**Proposed code:** `article.root-relative-source-link`  
**Severity:** error

Fail when a normal Markdown link in an article has a destination beginning with
`/` (but not `//`) and is not a supported platform-local route. An imported
article's source-site-relative link resolves against Lens Platform rather than
the source website and is therefore broken.

The importer should resolve these links against `source_url`; the validator
should diagnose any that survive.

Malformed:

```markdown
[Deep Machinery of Steering](/3/smart-ais-spot-lies-and-opportunities#deep-machinery-of-steering)
```

Valid:

```markdown
[Deep Machinery of Steering](https://ifanyonebuildsit.com/3/smart-ais-spot-lies-and-opportunities#deep-machinery-of-steering)
[Section](#section)
![Hosted figure](https://cdn.example.org/figure.png)
```

Keep the existing `article.attachment-url-unservable` behavior for the known
unsupported `/attachments/...` image route; do not emit both codes for the same
image.

### 2. Empty math nodes and delimiters

**Proposed code:** `article.math-empty`  
**Severity:** error

Detect empty or whitespace-only recognized math outside code, comments,
CriticMarkup, and frontmatter. This needs a scanner as well as AST inspection
because conservative math parsing may leave some delimiter forms as text.

Malformed:

```markdown
I would pay Jaime\(\) \(\$100(1 - 0.4^2) = \$84\).
```

```markdown
Before

$$
$$

After
```

Valid controls:

```markdown
I would pay Jaime \(\$100(1 - 0.4^2) = \$84\).
Use the literal string `\(\)` in documentation.
The price is $5 and the fee is $10.
```

### 3. Extend `article.tex-outside-math`

The existing rule should recognize doubled/escaped TeX commands produced by
converters, including Greek symbols and relation operators.

Malformed audit examples:

```markdown
The parameter \\beta quantifies the returns.
The parameter \\lambda captures the growth rate.
The ratio r = \\lambda / \\beta.
The estimate is r \\approx 0.32.
The parameter \\theta also influences the result.
```

Valid controls:

```markdown
The parameter $\beta$ quantifies the returns.
The ratio is $r \approx 0.32$.
The source code `\\beta` is discussed here.
```

Retain the usual exclusions for code, authoring comments, CriticMarkup, and
valid math nodes.

### 4. Suspicious flattened TeX and operators inside math

**Proposed code:** `article.math-token-flattened`  
**Severity:** warning

KaTeX can successfully parse semantically damaged expressions such as `$pi$`
as ordinary variables. Add an operator/token scanner for inline and display
math; display math should receive the strictest checks because prose-like
tokens there are especially unlikely to be intentional. Warn on high-signal
converter vocabulary, ASCII operators, and malformed subscript/superscript
shapes even when KaTeX accepts the expression.

Audit examples:

```markdown
$pi: S -> A$
$a_t tilde pi_theta(dot.c | s_t)$
$R: (S times A) -> RR$
$sum_(t=0)^infinity gamma^t r_t$
$V^pi(s_t = s) = E_pi(R | s_t = s)$
$s_(t+1)$
```

Likely intended forms were `\pi`, `\to`, `\sim`, `\cdot`, `\times`,
`\mathbb{R}`, `\sum`, `\infty`, `\gamma`, and `\mathbb E`.

High-signal candidates include:

- Greek names without a backslash: `pi`, `mu`, `theta`, `phi`, `gamma`;
- spelled operators/constants: `times`, `tilde`, `sum`, `infinity`, `dot.c`,
  and `RR` when used as a codomain;
- ASCII operator spellings in display math: `->`, and suspicious bare `|`
  where `\to` or `\mid` is expected;
- `_(` and `^(` grouping. TeX almost always requires braces for multi-character
  subscripts and superscripts, e.g. `s_{t+1}` rather than `s_(t+1)`;
- prose quotes or quoted operands inside display math when `\text{...}` is the
  likely intent.

In display math, a bare Greek-name token such as `pi` should warn even when it
appears alone. Inline math may use a slightly higher evidence threshold to
avoid flagging a legitimate multi-letter variable. This remains a hybrid rule:
the validator should identify the suspicious expression and suggest source
comparison, not invent the replacement.

### 5. Converter and submission-system residue

**Preferred implementation:** extend `article.page-chrome-residue` where the
finding is merely visible residue. If a distinct code is operationally useful,
use `article.converter-residue`.  
**Severity:** warning by default; error only for syntax known to damage rendering

Add high-signal patterns outside code, comments, CriticMarkup, and frontmatter:

- standalone LaTeX environment names in converted prose, such as `longtable`
  immediately before an Abstract or section heading;
- document-submission diagnostics, including the ICML sequence:
  `marginparsep has been altered`, `The page layout violates the ICML style`,
  and instructions to remove layout-changing packages;
- literal serialized UI controls such as `_(button: Give feedback)_`;
- duplicated converter list markers such as `1. 1.` or list items whose content
  begins with a redundant bullet glyph (`- • ...`).

Valid controls must include prose that discusses `longtable` or ICML formatting,
plus the same strings inside fenced and inline code.

`footnotetext:` is recognizable in the audited paper, but one occurrence is not
enough evidence for a general production rule. Before adding it, scan the full
corpus and converter fixtures for the same family of residue. If it recurs,
prefer a narrow `article.page-chrome-residue` pattern plus nearby valid controls;
otherwise leave it as an LLM/converter-specific finding. Do not build a broad
footnote rule around the single `††footnotetext:` example.

### 6. Emphasis boundary malformed

**Proposed code:** `article.emphasis-boundary-malformed`  
**Severity:** warning

The audit contained:

```markdown
a *dynamically consistent* and*reflectively stable* account
```

The intended text was:

```markdown
a *dynamically consistent* and *reflectively stable* account
```

This exact malformed case was **not caught by the current validator**. Add it as
a regression fixture before implementing the rule.

Warn when an otherwise complete emphasis/strong span touches an adjacent word
in a way that prevents or unexpectedly changes CommonMark emphasis parsing.
Use the renderer AST plus a source scanner, and include controls for punctuation,
mathematical asterisks, escaped asterisks, and code. Do not attempt a general
"fused English words" rule: findings such as `shapeof` and
`outsideresearchers` need spellchecking/LLM review and would create excessive
false positives in technical articles.

### 7. Announced structure with no following structure

**Proposed code:** `article.announced-structure-missing`  
**Severity:** warning, experimental

Two real omissions had local cues:

```markdown
We distinguish three important feedback loops that could drive an intelligence explosion:

### Time lags in each feedback loop
```

```markdown
The rest of the paper lays out our analysis in more detail. We proceed as follows:

## Relation to previous work
```

A conservative rule may warn when a sentence ends with a colon and explicitly
announces an enumeration (`the following`, `three types`, `as follows`) but the
next substantive node is a heading rather than a list, definition, table, or
paragraph satisfying the announcement.

This must remain a warning and be evaluated across the full corpus before
shipping. Natural prose makes it unsuitable as a hard error. If precision is
poor, leave it exclusively to the LLM checker.

## Deterministic checks that belong in the importer

These require the fetched source and should not add network behavior to
`POST /api/content/validate-article`:

1. **Canonical URL:** compare `source_url` with the fetched page's canonical URL
   and redirects. One audited LessWrong URL had a stale slug.
2. **Publication date:** compare frontmatter with trustworthy JSON-LD, OpenGraph,
   adapter API, or publication metadata. Two audited articles had wrong dates.
3. **Author versus publisher:** prefer structured person/byline fields over site
   names. The audit removed `Ambitious Impact` from a person-author list and
   replaced `Clearer Thinking` with the credited writer.
4. **Root-relative link resolution:** resolve source-relative links during HTML
   conversion so the validator is only a backstop.
5. **Source-version snapshot:** when a URL redirects to a substantially revised
   or retitled article, record an access/import date and route the decision to
   review instead of silently mixing versions.

These checks should produce structured findings that can be passed to the LLM
checker and stored in importer diagnostics.

Do not add an offline rule for an unlabeled, comma-separated keyword line. The
audited line was recognizable only from its position and source meaning, and
the pattern is both rare and too ambiguous. Leave detached keyword labeling to
the LLM checker (or source-structured metadata extraction in an adapter).

## Broken-article review marker policy

When an audit or importer determines that an article is substantially broken
and should be re-imported, place the notice at the **top of the article body**
inside an Obsidian authoring comment:

```markdown
%%
This imported article is severely truncated relative to the source. Re-import
the complete article before using it in a lens.
%%
```

Never leave these notices as visible prose. In particular, the truncation notice
for `iabied-ch13-faq-warning-shots.md` should use this top-of-body `%% ... %%`
form rather than a comment beside an internal heading. The same policy applies
to paraphrase-only imports and documents whose figures/tables are too damaged
for safe piecemeal repair.

The validator and renderer already strip authoring comments where appropriate;
new rules must ignore the contents of these notices.

## Findings that should remain LLM/source-comparison checks

Do not attempt to make these offline validator errors:

- a coherent introduction/conclusion with multiple middle sections missing;
- an imported body that is a fluent condensed paraphrase rather than the full
  source article;
- a missing conceptual list or central explanatory section whose wording is
  unavailable locally;
- figures reduced to disconnected formula tokens and subfigure labels;
- source footnote links whose actual definitions were never imported;
- semantically corrupted but syntactically valid math when no high-signal token
  pattern is present;
- deciding whether unusual tables, interactive controls, publication front
  matter, captions, or repeated content are source-authentic;
- choosing between repairing a severely damaged PDF/arXiv conversion and
  requiring a complete re-import;
- recognizing and labeling a detached keyword line without structured source
  metadata.

The LLM checker should be told explicitly to flag major damage for re-import
rather than reconstructing unavailable content.

## Suggested test matrix

For every new or extended rule, add:

- one malformed audit-derived fixture and one nearby valid control;
- inline code, fenced code, authoring-comment, CriticMarkup, and frontmatter
  exclusions;
- LF and CRLF forms;
- exact code, severity, path, and line assertions;
- cases nested in lists, blockquotes, tables, and footnotes where relevant;
- parity through one-file `processContent` and
  `POST /api/content/validate-article`.

Run new warnings over the complete Relay article corpus before promotion. Any
candidate error with legitimate hits should be narrowed or demoted. Do not
hard-code importer behavior to a fixed list of warning severities; consume the
endpoint's current `severity`, `code`, `line`, and `suggestion` fields.

## Recommended priority

1. Root-relative external links.
2. Empty math and doubled TeX outside math.
3. Converter/submission residue patterns.
4. Suspicious flattened TeX and operator tokens inside math.
5. Emphasis boundary warning.
6. Experimental announced-structure warning, only if corpus precision is good.
7. Separate importer metadata/source checks.
