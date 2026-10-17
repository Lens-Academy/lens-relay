---
id: '572ab9ce-6af0-4196-8685-e7ecfa8cd12b'
title: "D.2.1 Overview and prerequisites"
source_url: https://iliad-intensive.org/agency/policy-gradients-misgeneralization/
upstream_commit: '46ea03c036a05c7687d702d509037521e19f3b0c'
---

#### Video
source:: [[../video_transcripts/iliad-when-bad-goals-also-fit-your-training-data]]

#### Text
content::
\## Prerequisites

- [D.1.2 - Reinforcement Learning](https://iliad-intensive.org/agency/reinforcement-learning/)
- Be familar with the [PyTorch prerequisites](https://iliad-intensive.org/foundations/prerequisites/).
  - In particular, if you're unfamilar with more advanced indexing like use of `torch.gather`, feel free
  to solve the exercise with a sequential python for-loop, and then use the solution code when you want 
  the training loop to run quickly.

:::callout {title="What you'll learn" tone="neutral"}

- Understand the derivation of (Vanilla) Policy Gradient (VPG).
- Implement Policy Gradient in PyTorch, and use to train an agent to play a toy RL environment.
- Understand reward functions, what behaviour they incentivise and whow they can be used as probes for behaviour.
- Understand what potential shaping is, and how it provides hints without allowing reward hacking.
- The difference between Goal Mis*generalisation* and Goal Mis*specification*.

:::

%% Facilitator logistics (hidden from learners):
\## Roadmap for today

- 10:00–10:30
  - Lecture on intro to Policy Gradient
- 10:30–13:00
  - Work through VPG material
- 13:00-14:00
  - (Lunch + Break Time)
- 14:00–14:30
  - Lecture on intro to Goal Misgeneralization
- 14:30–17:30
  - Work through Goal Misgen. material
- 17:30–18:00
  - Buffer + Feedback
%%
