# Retroactive article review: exact proposed changes

Date: 2026-08-27  
Run: `2026-08-27-d5816957`

This document records the exact pending CriticMarkup created by the ten-article
retroactive review run. It is based on Relay's production suggestion index, not
on a diff against an older Git checkout.

Nine articles received pending suggestions. One article, GiveWell's Giving 101
Guide, was blocked before any suggestion was written. Nothing listed here has
been accepted automatically.

## Common executor changes

Every successful review proposed an `llm-review` provenance block. This is
added by the review executor after the model finishes; it is not an editorial
choice made by the model. Each successful review also proposed the same
whitespace-only change immediately below frontmatter:

```text
delete: "\n\n"
insert: "\n"
```

In context, this removes one blank line before the existing `%%` authoring
comment block.

## 1. Claude's new constitution

[Open review](https://editor.lensacademy.org/bdb65df2/Lens-Edu/articles/anthropic-claudes-new-constitution.md)

Model-authored content changes: **none**.

The only pending changes are the common whitespace change and this exact
executor-added provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 2. We need a science of evals

[Open review](https://editor.lensacademy.org/f18d1a05/Lens-Edu/articles/chris+apollo-research-we-need-a-science-of-evals.md)

Model-authored content changes: **none**.

The only pending changes are the common whitespace change and this exact
executor-added provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 3. A starter guide for evals

[Open review](https://editor.lensacademy.org/ecafb6d7/Lens-Edu/articles/hobbhahn+etal-a-starter-guide-for-evals.md)

Exact model-authored change:

```diff
-Playing with LLMs
+### Playing with LLMs
```

This promotes a plain-text line to a level-three heading. The review also
contains the common whitespace change and this provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 4. Risks from learned optimization

[Open review](https://editor.lensacademy.org/3cb26e4d/Lens-Edu/articles/alignmentforum-risks-from-learned-optimization-introduction-ai-alignment-forum.md)

Exact model-authored change:

```diff
 author:
   - "Chris van Merwijk"
   - "Vladimir Mikulik"
   - "Joar Skalse"
+  - "Scott Garrabrant"
```

The review adds a missing coauthor. It also contains the common whitespace
change and this provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 5. Janus Simulators

[Open review](https://editor.lensacademy.org/a41e8f80/Lens-Edu/articles/alexander-janus-simulators.md)

Model-authored semantic changes: **none**.

Besides the common whitespace and provenance changes, Relay contains four
delete/add pairs whose inserted text is byte-identical to the deleted text:

```text
"GPT"       -> "GPT"
"GPT-3."    -> "GPT-3."
"This"      -> "This"
"identity." -> "identity."
```

These are no-op anchoring artifacts and should not be accepted as meaningful
editorial changes.

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 6. The world keeps getting saved

[Open review](https://editor.lensacademy.org/39a820e9/Lens-Edu/articles/Bogoed-the-world-keeps-getting-saved.md)

Model-authored content changes: **none**.

The only pending changes are the common whitespace change and this provenance
block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 7. Sources of advantage for digital agents over biological agents

[Open review](https://editor.lensacademy.org/29e70d08/Lens-Edu/articles/bostrom-sources-of-advantage-for-digital-agents-over-biological-agents.md)

Exact model-authored change:

```diff
-> Sources of advantage for digital intelligence 
+> **Sources of advantage for digital intelligence**
```

This bolds a heading-like line inside a blockquote and removes its trailing
space. The review also contains the common whitespace change and this
provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 8. Special behavior is built out of mundane parts

[Open review](https://editor.lensacademy.org/8718f832/Lens-Edu/articles/iabied-ch1-ext-mundane-parts.md)

Exact model-authored changes:

```diff
-In most cases, we don't know the *meaning*, the higher-level patterns that allow the brain to do the work it does*.*[^note-iabied-ftnt42]
+In most cases, we don't know the *meaning*, the higher-level patterns that allow the brain to do the work it does.[^note-iabied-ftnt42]
```

```diff
-[2] *Quoting Kelvin:* Lord Kelvin, "On the Dissipation of Energy: Geology and General Physics," in *Popular**Lectures and Addresses, vol. ii* (London: Macmillan, 1894).
+[2] *Quoting Kelvin:* Lord Kelvin, "On the Dissipation of Energy: Geology and General Physics," in *Popular Lectures and Addresses, vol. ii* (London: Macmillan, 1894).
```

These remove two malformed emphasis boundaries. The review also contains the
common whitespace change and this provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 9. Scope insensitivity

[Open review](https://editor.lensacademy.org/362879d7/Lens-Edu/articles/animal-ethics-scope-insensitivity.md)

Exact model-authored changes:

```diff
-one trillion animals
+one *trillion* animals

-called scope insensitivity. It is also known as scope neglect.
+called *scope insensitivity*. It is also known as *scope neglect*.

-2$ less to save 18,000 more individuals
+2$ less to save 18,000 *more* individuals

-which is called representativeness heuristic
+which is called *representativeness heuristic*

-Like all heuristics, this can be a useful mental shortcut
+Like all heuristics, this is can be a useful mental shortcut

-what is often called the collapse of compassion,
+what is often called the *collapse of compassion*,

-the number of insects in the wild is 1018.
+the number of insects in the wild is 10<sup>18</sup>.
```

The `this can be` → `this is can be` edit introduces a grammatical error and
should be rejected. The other changes restore emphasis or exponent formatting
visible in the rendered source. The review also contains the common whitespace
change and this provenance block:

```yaml
llm-review:
  date: 2026-08-27
  model: "sonnet"
  version: "article-qc-v1"
  source:
    fetched: 2026-08-27
    kind: "live"
```

## 10. GiveWell's Giving 101 Guide

No suggestion was written. Relay rejected the attempted edit because it would
have removed a non-AI-authored comment.

The exact attempted deletion was:

```diff
-*Licensed under [CC BY-NC-SA 3.0 US](https://creativecommons.org/licenses/by-nc-sa/3.0/us/).*
-
-{>>TODO: Licensed content<<}
```

Removing the Creative Commons attribution matches the review policy. Removing
the human-authored `TODO: Licensed content` comment does not, so Relay correctly
blocked the whole edit.

## What this sample actually shows

- Three reviews found no content change at all: Claude's constitution, Science
  of Evals, and The World Keeps Getting Saved.
- One review found only a missing heading level.
- One found a missing coauthor.
- Two repaired malformed presentation markup.
- One made several source-formatting repairs but also introduced a grammatical
  regression.
- One long review produced only no-op anchoring artifacts.
- The licensing rule found the intended Creative Commons line, while Relay's
  human-comment protection prevented an over-broad deletion.

The sample therefore contains useful repairs, but it also supports keeping the
human review step: provenance-only changes, no-op suggestions, and one clear
regression should not be bulk-accepted without inspection.
