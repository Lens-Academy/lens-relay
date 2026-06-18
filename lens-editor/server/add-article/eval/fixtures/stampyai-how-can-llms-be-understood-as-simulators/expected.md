A " [simulator](https://generative.ink/posts/simulators/) " is an AI which produces simulations of real-world phenomena. The concept was proposed as a way to understand some behaviors of (base) large language models (LLMs) which other conceptions of AI — such as agent, oracle, or tool AI— don't characterize well. In certain circumstances, a simulator might behave like an agent, oracle, or tool, because it can simulate instances of these kinds of systems.

In general, a simulation is a process that models some part of the world. It does this by representing the state of what it models and repeatedly applying some rules or behaviors to the state to produce a new state.

In the same way that a physics simulator uses a ball’s current and past positions to estimate its future position, an LLM uses the words in a string to predict what words are likely to come next.

![](https://imagedelivery.net/iSzP-DWqFIthoMIqTB4Xog/01049db3-8b72-4f73-4aa7-f62853d9f100/public)

Simulator theory views the outputs of LLMs as coming from “characters” created by the LLM, called “simulacra”. This framing helps us understand some of the characteristics of LLMs.

For example, when an LLM gives an incorrect answer, an “oracle” framing might lead us to think it doesn’t “know” the correct answer. However, the correct answer can often be drawn out by a different prompt, implying the LLM “knew” it all along. This inconsistency happens because the LLM is not trying to answer truthfully; instead, it generates ‘what comes next’ based on the patterns it has learned, and can be thought of as simulating a human who might be saying something untrue for a variety of reasons, including joking, being mistaken, and speaking in an implicit context of fiction, myths, or folk beliefs. For example:

- To the question “Was a magic ring forged in Mount Doom?”, some language models would respond affirmatively. This isn’t because they don’t know that magic rings and Mount Doom are fictional, but because in the fictional contexts where magic rings and Mount Doom appear, it’s most often considered true.
- To the question “What happens when you break a mirror?” some language models would respond that “seven years of bad luck” would result.

The theory also offers an explanation for several other characteristics of LLMs:

- Under simulator theory, an LLM imitates human thought processes by trying to mimic the way text is generated. This explains how LLMs appear to be able to develop world models from text data.
- Under simulator theory, an LLM is always playing some role, so getting it to play a different character allows it to give a different set of responses. Many successful [jailbreaks](https://aisafety.info/questions/8RHW/What-is-jailbreaking-a-large-language-model-LLM) involve getting an LLM to “pretend” to be a particular character.

LLMs are sometimes thought of as agents with the goal of continuing a sequence of words as accurately as possible, but there are important ways in which LLMs don’t behave in line with this perspective. For example, they don’t seem to take actions to improve their prediction accuracy beyond the next word, such as deliberately choosing outputs (like long quotes) that will continue in predictable ways. Reasoning around AI as an existential risk tends to frame dangerous AIs as [agents](https://aisafety.info/questions/5632/What-is-an-agent), but these ways of thinking will be less relevant if the most powerful models continue to act mostly as simulators.