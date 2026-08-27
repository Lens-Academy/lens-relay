# Retroactive article review: second-run overview

Date: 2026-08-27  
Run: `2026-08-27-b60f060c`  
Reviewer: `article-qc-v2` / Sonnet

This was a fresh 20-article run. Fourteen articles received pending suggestions;
six failed closed. Nothing was accepted automatically. The changes below come
from Relay's production suggestion index, not from an older Git checkout.

## Common executor changes

Every successful review adds an `llm-review` provenance block. The executor,
not the model, also normalizes the excess blank line before the leading `%%`
authoring comment:

```text
delete: "\n\n"
insert: "\n"
```

The model no longer makes this whitespace-only edit. The suggestion remains
visible because deterministic retroactive repairs still require human approval.

## Successful reviews

### 1. Why I’m optimistic about our alignment approach

[Open review](https://editor.lensacademy.org/29a6be81/Lens-Edu/articles/leike-why-im-optimistic-about-our-alignment-approach.md)

```diff
-published: 2023-02-15
+published: 2022-12-05
```

```diff
-Out of the box they aren’t agents who are trying to pursue their own goals in the world and and their objective functions are quite malleable.
+Out of the box they aren’t agents who are trying to pursue their own goals in the world and their objective functions are quite malleable.
```

The date repair is source-backed. The wording repair removes one duplicated
`and`; the source and reviewed article both retain the other one. Relay displayed
the repair as a one-token deletion, which made the overview's first rendering
look like the reviewer had removed the only `and`.

### 2. Reward is not the optimization target

[Open review](https://editor.lensacademy.org/54184f29/Lens-Edu/articles/turntrout-reward-is-not-the-optimization-target.md)

Repairs a corrupted/truncated description tail:

```diff
-He argues reward is b…"
+He argues reward instead functions as a reinforcement schedule that chisels cognition into an agent, rather than encoding a utility function to be optimized."
```

### 3. Introduction to Mechanistic Interpretability

[Open review](https://editor.lensacademy.org/701eb45a/Lens-Edu/articles/sarah+bluedot-introduction-to-mechanistic-interpretability.md)

No model-authored content change. Only provenance and deterministic spacing.

### 4. Longtermism and Animal Advocacy

[Open review](https://editor.lensacademy.org/2128996e/Lens-Edu/articles/baumann-longtermism-and-animal-advocacy-before-clean-reimport.md)

This is the largest substantive recovery in the batch. It restores omitted
phrases and sentences throughout the article, including these exact changes:

```diff
-A long-term focus differs in two main ways.
+I will argue that a long-term focus differs in two main ways.

-**First**, a longtermist outlook...
+First, a longtermist outlook...

-long-term goals.
+long-term goals (as individuals, as organisations, and as a movement).

+This could happen because animal advocacy itself becomes increasingly divisive, or because the movement is associated with other highly contentious political views. (Excessive polarisation and divergence of values are also a risk factor for s-risks.)

-**Second**, it is crucial...
+Second, it is crucial...

-antispeciesism rather than veganism specifically.
+antispeciesism rather than veganism.

-biases might distort our thinking.
+biases might distort our thinking and should consider many possible strategies, including unorthodox ones such as the idea of patient philanthropy.

-the likelihood of a lock-in of values,
+the likelihood of a lock-in of values (rather than continued value drift),

-My aim is just to argue...
+Discussing these factors in detail is beyond the scope of this post – my aim is just to argue...

-Future people might engage in moral reflection
+Future people might value moral reflection

+It seems unlikely, though, that humans will be most numerous.

-prevent risks of astronomical suffering).
+prevent risks of astronomical suffering), due to the possibility of compromise and greater leeway afforded by powerful future technology.

-This seems possible but far from clear.
+This seems possible but far from clear, and we would still need to work on ensuring even a low degree of moral concern, as well as adequate processes for implementing compromise.

-industries becomes less meaningful
+industries (or live in nature) becomes less meaningful

+It is, however, still good to be aware of the numbers to make more effective decisions in the short term and as an input for our estimates of sources of future suffering.
```

It also removes the terminal Creative Commons license notice.

#### Clean-import comparison

[Open the preserved reviewed version](https://editor.lensacademy.org/2128996e/Lens-Edu/articles/baumann-longtermism-and-animal-advocacy-before-clean-reimport.md) · [Open the clean import](https://editor.lensacademy.org/6297919b/Lens-Edu/articles/baumann-longtermism-and-animal-advocacy.md)

The clean import is materially more complete: 11,584 body characters versus
6,807; 30 links versus zero; and six source footnotes that were absent from the
reviewed version. It recovered every URL found in the rendered source, including
the citations attached to phrases such as `longtermism`, `moral circle
expansion`, `antispeciesism`, `patient philanthropy`, and `value drift`.

The old text's distinct vocabulary is 99.3% covered by the clean import, while
only 81.7% of the clean import's distinct vocabulary occurs in the old version.
This confirms that the retroactive reviewer recovered several visible omissions
but could not reconstruct the missing link graph and footnotes from that draft.

### 5. Why AI alignment could be hard with modern deep learning

[Open review](https://editor.lensacademy.org/c17f21ab/Lens-Edu/articles/cotra-why-ai-alignment-could-be-hard-with-modern-deep-learning.md)

No model-authored content change. Only provenance and deterministic spacing.

### 6. The Need for Biases in Learning Generalizations

[Open review](https://editor.lensacademy.org/f5f78942/Lens-Edu/articles/mitchell-the-need-for-biases-in-learning-generalizations.md)

Wraps the terminal acknowledgements in a collapse block:

```diff
 ## 6. Acknowledgements
 
+:::collapse
 The following people have provided thoughtful comments...
+:::
```

### 7. How undesired goals can arise with correct rewards

[Open review](https://editor.lensacademy.org/c353939e/Lens-Edu/articles/shah-how-undesired-goals-can-arise-with-correct-rewards.md)

```diff
-published: 2022-03-01
+published: 2022-10-07
```

### 8. Specification gaming: the flip side of AI ingenuity

[Open review](https://editor.lensacademy.org/fccd93fc/Lens-Edu/articles/krakovna-specification-gaming-the-flip-side-of-ai-ingenuity.md)

Adds the missing image caption:

```diff
+Source: AI Learns to Walk (Code Bullet, 2019)
```

### 9. Donating like a startup investor: Hits-based giving, explained

[Open review](https://editor.lensacademy.org/dee499d3/Lens-Edu/articles/gwwc-hits-based-giving.md)

Repairs the author/date and restores seven omitted source passages:

```diff
-author: Giving What We Can
-published: 2023-12-06
+author: Shakeel Hashim
+published: 2022-03-01

+(Full disclosure: Open Philanthropy provides funding for Giving What We Can.)

+a charitable foundation established by oil tycoon John D. Rockefeller,

+Rockefeller isn't the only example of successful hits-based giving.

+impact, and it's why Giving What We Can and many others think about these factors when advising donors how to maximise their

+And for certain interventions, it's almost impossible to conduct research to see if they'll work.

-whether interventions are really having the desired impact.
+whether interventions are really having the desired impact, and to what degree. That approach can be important in making sure that money goes to the places where it can do the most good.

-incubates new charities to solve big problems.
+incubates new charities to solve big problems, and you can donate to these nonprofit startups.
```

### 10. The Rocket Alignment Problem

[Open review](https://editor.lensacademy.org/28ab7bba/Lens-Edu/articles/yudkowsky-the-rocket-alignment-problem.md)

No model-authored content change. Only provenance and deterministic spacing.

### 11. AI is easy to control

[Open review](https://editor.lensacademy.org/ab46aca6/Lens-Edu/articles/optimism-ai-is-easy-to-control.md)

```diff
-published: 2023-11-29
+published: 2023-11-28
```

### 12. The world is much better. The world is awful. The world can be much better.

[Open review](https://editor.lensacademy.org/31ced0f9/Lens-Edu/articles/roser-the-world-is-much-better-awful-can-be-better.md)

Restores three omitted passages, collapses the terminal acknowledgements, and
removes the terminal Creative Commons notice:

```diff
+See the data shown [here](https://www.gatesnotes.com/Development/Max-Roser-three-facts-everyone-should-know).

-But the mortality rate was surprisingly similar...
+But as the linked article shows, the mortality rate was surprisingly similar...

+If we look at single countries, this difference becomes even more striking as in the countries with the best health, the child mortality rate is again almost twice as low as in the EU as a whole.

+The countries with the lowest mortality rates today include San Marino, Norway, Japan, Finland, Singapore, Iceland, and Slovenia, where 99.7% of all children survive. [This chart](https://ourworldindata.org/grapher/youth-mortality-rate?tab=table&country=~OWID_WRL) shows the ranking. However, because several of these countries are small, I did not base this text on the data from any single country but on a large world region where millions of children are born every year.

+:::collapse
 **Acknowledgments:** I would like to thank Hannah Ritchie and Toby Ord for their feedback on this article.
+:::

-*This work is licensed under a Creative Commons Attribution 4.0 International License.*
```

### 13. On Caring

[Open review](https://editor.lensacademy.org/d905c56b/Lens-Edu/articles/soares-on-caring.md)

Restores source links and omitted wording, corrects the date, and removes the
terminal license notice:

```diff
-published: 2014-10-07
+published: 2014-10-04

-dire poverty
+squalor

-20, and maxing out around 150
+20

-Deepwater Horizon
+[Deepwater Horizon](http://en.wikipedia.org/wiki/Deepwater_Horizon_oil_spill)

-Ice Bucket Challenge
+[Ice Bucket Challenge](http://en.wikipedia.org/wiki/Ice_Bucket_Challenge)

-effective altruism
+[effective altruism](http://effectivealtruism.org/)

+(Though I'll plug the Giving What We Can pledge, GiveWell, MIRI, and The Future of Humanity Institute as a good start).

-trying to address them
+doing it anyway,

-more
+most
```

The runner initially marked this failed, but the only mismatch was Relay's
required final newline; the pending accepted-draft content otherwise matches
the reviewed file byte-for-byte. The newline comparison has now been fixed.

### 14. Radical Empathy

[Open review](https://editor.lensacademy.org/70c11d7c/Lens-Edu/articles/karnofsky-radical-empathy.md)

This restores a large amount of wording and link markup from the current
source. Representative exact changes include:

```diff
+***Editor's note:*** This article was published under our former name, The Open Philanthropy Project. Some content may be outdated. See our latest writing here. Holden Karnofsky is a co-founder and former CEO of Open Philanthropy. He left Open Philanthropy in April 2024.

-"all-inclusive";
+"all-inclusive":

-could
+*could*

-does
+is

-literally feeling
+*literally feeling*

-embraces / excluding / downplaying
+to embrace / to exclude / downplay

-**Acknowledging
+**Acknowledge

-**Not limiting
+**Don't limit

-Giving USA,
+[Giving USA](https://givingusa.org/),

-Luke Muehlhauser
+[Luke Muehlhauser](https://coefficientgiving.org/about/team/luke-muehlhauser)
```

It also updates multiple former Open Philanthropy URLs to Coefficient Giving,
restores links for sources and examples, repairs paragraph boundaries, and
removes the terminal Creative Commons notice. As with On Caring, the runner's
reported failure was only a final-newline comparison false negative; the
reviewed content itself matches Relay's accepted-draft view.

## Failed closed: no pending suggestions

- **Interpretability Will Not Reliably Find Deceptive AI** — Relay could not
  uniquely apply the first exact edit anchor.
- **What AI evaluations for preventing catastrophic risks can and cannot do**
  — same exact-anchor failure.
- **What is effective altruism?** — Claude exited after the configured review
  period, including one reduced-concurrency retry.
- **Four Ideas You Already Agree With** — Claude exited on both attempts.
- **Intelligence Explosion: Evidence and Import** — the source reviewer would
  not invent a precise date, so strict final metadata validation rejected it.
- **Letter from Utopia** — same invalid-date outcome.

## Provenance digests

All blocks have date `2026-08-27`, model `sonnet`, version `article-qc-v2`,
source fetched `2026-08-27`, and source kind `live`.

| Article | Reviewed content SHA | Source evidence SHA |
|---|---|---|
| Alignment optimism | `624f8dcc…67a8` | `e05f14a0…a91d` |
| Reward target | `b3c84945…55b5` | `19997af9…26d4` |
| Mechanistic interpretability | `0fe14a11…233f` | `d9a5dab9…4520` |
| Longtermism and animals | `4a41366c…557` | `80678092…9038` |
| Modern deep learning | `d1f7dc7a…ae67` | `2e147e09…793a` |
| Need for biases | `2d6d8622…1634` | `3b070b9f…177d` |
| Undesired goals | `89ca27f0…0ecb` | `91a56cac…8356` |
| Specification gaming | `3f3bba64…6055` | `da8f1988…5512` |
| Hits-based giving | `5993cb70…5e45` | `d8e31dbc…009a0` |
| Rocket alignment | `057b0681…719a` | `b1599596…b2f7` |
| AI control | `e8084e90…ee15` | `e94e37c8…cb28` |
| World better/awful | `273a79f4…afd` | `7baa7bf5…fed8` |
| On Caring | `7b691c4c…41a7` | `70b08f91…1944` |
| Radical Empathy | `7688ac9c…7009` | `11059ec8…d27d` |

## What this sample shows

- Three reviews found no content repair at all.
- Four corrected dates or other metadata.
- Several restored genuinely missing sentences or paragraphs.
- Two used the new collapse policy appropriately on terminal material.
- Licensing notices were removed without changing protected comments.
- The typo guard prevented the obvious source-typo regression seen in the
  first run.
- Parallel Claude pressure caused reproducible CLI exits on two long articles.
- The publisher needs stronger transaction semantics: exact-anchor failures
  were safe, but post-publication equality checks happen after edits are
  already suggested. In the two observed mismatch cases, the only difference
  was a final newline, now fixed.

Overall, this run found materially more useful omissions than the first sample,
while still supporting human review before acceptance.
