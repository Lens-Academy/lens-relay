# tl;dr
AI alignment has a culture clash. On one side, the “technical-alignment-is-hard” / “rational agents” school-of-thought argues that we should expect future powerful AIs to be power-seeking ruthless consequentialists. On the other side, people observe that both humans and LLMs are obviously capable of behaving like, well, not that. The [latter group accuses the former](https://www.mechanize.work/blog/unfalsifiable-stories-of-doom/) of head-in-the-clouds abstract theorizing gone off the rails, while the [former accuses the latter](https://www.lesswrong.com/posts/LvKDMWQ3yLG9R3gHw/empiricism-as-anti-epistemology) of mindlessly assuming that the future will always be the same as the present, rather than trying to understand things. “Alas, the power-seeking ruthless consequentialist AIs are still coming,” sigh the former. “Just you wait.”

As it happens, I’m basically in that “alas, just you wait” camp, expecting ruthless future AIs. But my camp faces a real question: what exactly is it about human brains[^1] that allows them to *not* always act like power-seeking ruthless consequentialists? I find that existing explanations in the discourse—e.g. [“ah but humans just aren’t smart and reflective enough”](https://www.lesswrong.com/posts/dKTh9Td3KaJ8QW6gw/why-assume-agis-will-optimize-for-fixed-goals?commentId=xdWq52Xg5yGoxD2dP), or [evolved modularity](https://www.lesswrong.com/posts/hsf7tQgjTZfHjiExn/my-take-on-jacob-cannell-s-take-on-agi-safety#1_1__Evolved_modularity__versus__Universal_learning_machine_), or [shard theory](https://www.lesswrong.com/posts/iCfdcxiyr2Kj8m8mT/the-shard-theory-of-human-values), etc.—to be wrong, handwavy, or otherwise unsatisfying.

So in this post, I offer my own explanation of why “agent foundations” toy models fail to describe humans, centering around a particular [non-“behaviorist” part of the RL reward function](https://www.lesswrong.com/posts/FNJF3SoNiwceAQ69W/behaviorist-rl-reward-functions-lead-to-scheming) in human brains that I call [Approval Reward](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to), which plays an outsized role in human sociality, morality, and self-image. And then the alignment culture clash above amounts to the two camps having opposite predictions about whether future powerful AIs will have something like Approval Reward (like humans, and today’s LLMs), or not (like utility-maximizers).

(You can read this post as pushing back against pessimists, by offering a hopeful exploration of a possible future path around technical blockers to alignment. Or you can read this post as pushing back against optimists, by “explaining away” the otherwise-reassuring observation that humans and LLMs don't act like psychos 100% of the time.)

Finally, with that background, I’ll go through six more specific areas where “alignment-is-hard” researchers (like me) make claims about what’s “natural” for future AI, that seem quite bizarre from the perspective of human intuitions, and conversely where human intuitions are quite bizarre from the perspective of agent foundations toy models. All these examples, I argue, revolve around Approval Reward. They are:

- 1\. The human intuition that it’s normal and good for one’s goals & values to change over the years
- 2\. The human intuition that ego-syntonic “desires” come from a fundamentally different place than “urges”
- 3\. The human intuition that kindness, deference, and corrigibility are natural
- 4\. The human intuition that unorthodox consequentialist planning is rare and sus
- 5\. The human intuition that societal norms and institutions are mostly stably self-enforcing
- 6\. The human intuition that treating other humans as a resource to be callously manipulated and exploited, just like a car engine or any other complex mechanism in their environment, is a weird anomaly rather than the obvious default

# 0. Background

## 0.1 Human social instincts and “Approval Reward”

As I discussed in [Neuroscience of human social instincts: a sketch (2024)](https://www.lesswrong.com/posts/kYvbHCDeMTCTE9TAj/neuroscience-of-human-social-instincts-a-sketch), we should view the brain as having a reinforcement learning (RL) reward function, which says that pain is bad, eating-when-hungry is good, and dozens of other things (sometimes called “innate drives” or “primary rewards”). I argued that part of the reward function was a thing I called the “compassion / spite circuit”, centered around a small number of (hypothesized) cell groups in the hypothalamus, and I sketched some of its effects.

Then last month in [Social drives 1: “Sympathy Reward”, from compassion to dehumanization](https://www.lesswrong.com/posts/KuBiv9cCbZ6ALjHFw/social-drives-1-sympathy-reward-from-compassion-to) and [Social drives 2: “Approval Reward”, from norm-enforcement to status-seeking](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to), I dove into the effects of this “compassion / spite circuit” more systematically.

And now in this post, I’ll elaborate on the connections between “Approval Reward” and AI technical alignment.

“Approval Reward” fires most strongly in situations where I’m interacting with another person (call her Zoe), and I’m paying attention to Zoe, and Zoe is also paying attention to me. If Zoe seems to be feeling good, that makes me feel good, and if Zoe is feeling bad, that makes me feel bad. Thanks to these brain reward signals, I want Zoe to like me, and to like what I’m doing. And then Approval Reward generalizes from those situations to other similar ones, including where Zoe is not physically present, but I imagine what she would think of me. It sends positive or negative reward signals in those cases too.

As I argue in [Social drives 2](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to), this “Approval Reward” leads to a wide array of effects, including credit-seeking, blame-avoidance, and status-seeking. It also leads not only to picking up and following social norms, but also to *taking pride* in following those norms, even when nobody is watching, and to shunning and punishing those who violate them.

This is not what normally happens with RL reward functions! For example, you might be wondering: “Suppose I surreptitiously[^2] press a reward button when I notice my robot following rules. Wouldn’t that likewise lead to my robot having a proud, self-reflective, ego-syntonic sense that rule-following is good?” I claim the answer is: no, it would lead to something more like an object-level *“desire to be noticed following the rules”*, with a sociopathic, deceptive, ruthless undercurrent.[^3]

I argue in [Social drives 2](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to) that Approval Reward is overwhelmingly important to most people’s lives and psyches, probably triggering reward signals thousands of times a day, including when nobody is around but you’re still thinking thoughts and taking actions that your friends and idols would approve of.

Approval Reward is so central and ubiquitous to (almost) everyone’s world, that it’s difficult and unintuitive to imagine its absence—we’re much like the proverbial fish who puzzles over what this alleged thing called “water” is.

…Meanwhile, a major school of thought in AI alignment implicitly assumes that future powerful AGIs / ASIs will almost definitely lack Approval Reward altogether, and therefore AGIs / ASIs will behave in ways that seem (to normal people) quite bizarre, unintuitive, and psychopathic.

The differing implicit assumption about whether Approval Reward will be present versus absent in AGI / ASI is (I claim) upstream of many central optimist-pessimist disagreements on how hard technical AGI alignment will be. My goal in this post is to clarify the nature of this disagreement, via six example intuitions that seem natural to humans but are rejected by “alignment-is-hard” alignment researchers. All these examples centrally involve Approval Reward.

## 0.2 Hang on, *will* future powerful AGI / ASI “by default” lack Approval Reward altogether?

This post is mainly making a narrow point that the proposition “alignment is hard” is closely connected to the proposition “AGI will lack Approval Reward”. But an obvious follow-up question is: are both of these propositions true? Or are they both false?

Here’s how I see things, in brief, broken down into three cases:

***If AGI / ASI will be based on LLMs:*** Humans have Approval Reward (arguably apart from some sociopaths etc.). And LLMs are substantially sculpted by human imitation (see my post [Foom & Doom §2.3](https://www.lesswrong.com/posts/bnnKGSCHJghAvqPjS/foom-and-doom-2-technical-alignment-is-hard#2_3_On_the_origins_of_egregious_scheming)). Thus, unsurprisingly, LLMs also display behaviors typical of Approval Reward, at least to some extent. Many people see this as a reason for hope that technical alignment might be solvable. But then the alignment-is-hard people have various counterarguments, to the effect that these Approval-Reward-ish LLM behaviors are fake, and/or brittle, and/or unstable, and that they will definitely break down as LLMs get more powerful. The cautious-optimists generally find those pessimistic arguments confusing ([example](https://www.lesswrong.com/posts/iy2o4nQj9DnQD7Yhj/discussion-with-nate-soares-on-a-key-alignment-difficulty)).

Who’s right? Beats me. It’s out-of-scope for this post, and anyway I personally feel unable to participate in that debate because I don’t expect LLMs to scale to AGI in the first place.[^4]

***If AGI / ASI will be based on RL agents (or similar)***, as expected by [David Silver & Rich Sutton](https://www.lesswrong.com/posts/TCGgiJAinGgcMEByt/the-era-of-experience-has-an-unsolved-technical-alignment), [Yann LeCun](https://www.lesswrong.com/posts/C5guLAx7ieQoowv3d/lecun-s-a-path-towards-autonomous-machine-intelligence-has-1), and [myself (“brain-like AGI”)](https://www.lesswrong.com/s/HzcM2dkCq7fwXBej8), among others, then the answer is clear: There will be no Approval Reward at all, unless the programmers explicitly put it into the reward function source code. And will they do that? We might (or might not) hope that they do, but it should definitely not be our “default” expectation, the way things are looking today.  For example, we don’t even know how to do that, and it’s quite different from anything in the literature. (RL agents in the literature almost universally have [“behaviorist” reward functions](https://www.lesswrong.com/posts/FNJF3SoNiwceAQ69W/behaviorist-rl-reward-functions-lead-to-scheming).) We haven’t even pinned down all the details of how Approval Reward works in humans. And even if we do, there will be technical challenges to making it work similarly in AIs—which, for example, do not grow up with a human body at human speed in a human society. And even if it were technically possible, and a good idea, to put in Approval Reward, there are competitiveness issues and other barriers to it actually happening. More on all this in future posts.

***If AGI / ASI will wind up like “rational agents”, “utility maximizers”, or related:*** Here the situation seems even clearer: as far as I can tell, under common assumptions, it’s *not even possible* to fit Approval Reward into these kinds of frameworks, such that it would lead to the effects that we expect from human experience. No wonder human intuitions and “agent foundations” people tend to talk past each other!

## 0.3 Where do self-reflective (meta)preferences come from?

This idea will come up over and over as we proceed, so I’ll address it up front:

![](https://res.cloudinary.com/lesswrong-2-0/image/upload/f_auto,q_auto/v1/mirroredImages/d4HNRdw6z7Xqbnu5E/drcvpvcyr4gred95wdl4)

When we compare “normal” motivations (a) with Approval Reward (b), the primary relation of object-level desires versus self-reflective meta-level desires (red arrows) is flipped. On the (a) side, we expect things like [reflective consistency](https://www.lesswrong.com/w/consequentialist-preferences-are-reflectively-stable-by) and goal-stabilization (cf. [instrumental convergence](https://www.lesswrong.com/w/instrumental-convergence)). On the (b) side, we don’t (necessarily); instead we may encounter radical goal-changes upon reflection and self-modification, along with a broader willingness for goals to change.

In the context of utility-maximizers etc., the starting point is generally that desires are associated with object-level things (whether due to the reward signals or the utility function). And from there, the meta-preferences will naturally line up with the object-level preferences.

After all, consider: what’s the main effect of ‘me wanting X’? It’s ‘me getting X’. So if getting X is good, then ‘me wanting X’ is also good. Thus, means-end reasoning (or anything functionally equivalent, e.g. RL backchaining) will echo object-level desires into corresponding self-reflective meta-level desires. And this is the only place that those meta-level desires come from.

By contrast, in humans, self-reflective (meta)preferences mostly ([though not exclusively](https://www.lesswrong.com/posts/73xBjgoHuiKvJ5WRk/intuitive-self-models-2-conscious-awareness#2_5_2_Positive_valence_S_X__models_also_tend_to_go_with_X_s_that_are_object_level_motivating__other_things_equal_)) come from Approval Reward. By and large, our “true”, endorsed, ego-syntonic desires are approximately whatever kinds of desires would impress our friends and idols (see [previous post §3.1](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to#3_1__How_I_think_of_myself__winds_up_wildly_skewed_towards__what_s_socially_admired_)).

Box: More detailed argument about where self-reflective preferences come from

The actual effects of “me wanting X” are

- (1) I may act on that desire, and thus get X (and stuff correlated with X),
- (2) Maybe there’s a *side-channel* through which “me wanting X” can have an effect:
	- (2A) Maybe there are (effectively) mind-readers in the environment,
	- (2B) Maybe my own reward function / utility function is itself a mind-reader, in the sense that it involves interpretability, and hence triggers based on the contents of my thoughts and plans.

Any of these three pathways can lead to a meta-preference wherein “me wanting X” seems good or bad. And my claim is that (2B) is how Approval Reward works (see [previous post §3.2](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to#3_2_The_habit_of_imagining_how_one_looks_in_other_people_s_eyes__10_000_times_a_day)), while (1) is what I’m calling the “default” case in “alignment-is-hard” thinking.

(What about (2A)? That’s another funny “non-default” case. Like Approval Reward, this might circumvent many “alignment-is-hard” arguments, at least in principle. But it has its own issues. Anyway, I’ll be putting the (2A) possibility aside for this post.)

(Actually, human Approval Reward in practice probably involves a dash of (2A) on top of the (2B)—most people are imperfect at hiding their true intentions from others.)

…OK, finally, let’s jump into those “6 reasons” that I promised in the title!

# 1. The human intuition that it’s normal and good for one’s goals & values to change over the years

In human experience, it is totally normal and good for desires to change over time. Not always, but often. Hence [emotive conjugations](https://en.wikipedia.org/wiki/Emotive_conjugation) like

- *“I was enculturated, you got indoctrinated, he got brainwashed”*
- *“I came to a new realization, you changed your mind, he failed to follow through on his plans and commitments”*
- *“I’m open-minded, you’re persuadable, he’s a flip-flopper”*

…And so on. Anyway, openness-to-change, in the right context, is great. Indeed, even our meta-preferences concerning desire-changes are *themselves* subject to change, and we’re generally OK with that too.[^5]

Whereas if you’re thinking about an AI agent with foresight, planning, and situational awareness (whether it’s a utility maximizer, or a model-based RL agent[^6], etc.), this kind of preference is a weird anomaly, *not* a normal expectation. The default instead is [instrumental convergence](https://www.lesswrong.com/w/instrumental-convergence): if I want to cure cancer, then I (incidentally) want to continue wanting to cure cancer until it’s cured.

Why the difference? Well, it comes right from that diagram in §0.3 just above. For Approval-Reward-free AGIs (which I see as “default”), their self-reflective (meta)desires are subservient to their object-level desires.

Goal-preservation follows: if the AGI wants object-level-thing X to happen next week, then it wants to want X right now, *and* it wants to *still* want X tomorrow.

By contrast, in humans, self-reflective preferences mostly come from Approval Reward. By and large, our “true”, endorsed desires are approximately whatever kinds of desires would impress our friends and idols, if they could read our minds. (They can’t actually read our minds—but our own reward function can!)

This pathway does not generate any particular force for desire preservation.[^7] If our friends and idols would be impressed by desires that change over time, then that’s generally what we want for ourselves as well.

# 2. The human intuition that ego-syntonic “desires” come from a fundamentally different place than “urges”

In human experience, it is totally normal and expected to want X (e.g. candy), but not *want to* want X. Likewise, it is totally normal and expected to dislike X (e.g. homework), but want to like it.

And moreover, we have a deep intuitive sense that the self-reflective meta-level ego-syntonic “desires” are coming from a fundamentally different place as the object-level “urges” like eating-when-hungry. For example, in a recent conversation, a high-level AI safety funder confidently told me that urges come from human nature while desires come from “reason”. Similarly, Jeff Hawkins dismisses AGI extinction risk partly on the (incorrect) grounds that urges come from the brainstem while desires come from the neocortex (see my [Intro Series §3.6](https://www.lesswrong.com/posts/hE56gYi5d68uux9oM/intro-to-brain-like-agi-safety-3-two-subsystems-learning-and#3_6_Response_to_Jeff_Hawkins_s_argument_against_AGI_accident_risk) for why he’s wrong and incoherent on this point).

In a very narrow sense, there’s actually a kernel of truth to the idea that, in humans, urges and desires come from different sources. As in [Social Drives 2](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to) and §0.3 above, one part of the RL reward function is Approval Reward, and is the primary ([though not exclusive](https://www.lesswrong.com/posts/73xBjgoHuiKvJ5WRk/intuitive-self-models-2-conscious-awareness#2_5_2_Positive_valence_S_X__models_also_tend_to_go_with_X_s_that_are_object_level_motivating__other_things_equal_)) source of ego-syntonic desires. Everything else in the reward function mostly gives rise to urges.

But this whole way of thinking is bizarre and inapplicable from the perspective of Approval-Reward-free AI futures—utility maximizers, “default” RL systems, etc. There, as above, the starting point is object-level desires; self-reflective desires arise only incidentally.

A related issue is how we think about **AGI reflecting on its own desires**. How this goes depends strongly on the presence or absence of (something like) Approval Reward.

Start with the former. Humans often have conflicts between ego-syntonic self-reflective desires and ego-dystonic object-level urges, and reflection allows the desires to scheme against the urges, potentially resulting in large behavior changes. If AGI has Approval Reward (or similar), we should expect AGI to undergo those same large changes upon reflection. Or perhaps even larger—after all, AGIs will generally have more affordances for self-modification than humans do.

By contrast, I happen to expect AGIs, by default (in the absence of Approval Reward or similar), to mainly have object-level, non-self-reflective desires. For such AGIs, I don’t expect self-reflection to lead to much desire change. Really, it shouldn’t lead to any change more interesting than pursuing its existing desires more effectively.

(Of course, such an AGI may feel torn between conflicting object-level desires, but I don’t think that leads to the kinds of internal battles that we’re used to from humans.[^8])

(To be clear, reflection in Approval-Reward-free AGIs might still have [“complications”](https://www.lesswrong.com/posts/rQDCQxuCRrrN4ujAe/jeremy-gillen-s-shortform?commentId=vYdtN3nHEtJfgjSSB) of other sorts, such as [ontological crises](https://www.lesswrong.com/w/ontological-crisis).)

# 3. The human intuition that helpfulness, deference, and corrigibility are natural

This human intuition comes straight from Approval Reward, which is absolutely central in human intuitions, and leads to us caring about whether others would approve of our actions (even if they’re not watching), taking pride in our virtues, and various other things that distinguish neurotypical people from sociopaths.

As an example, [here’s Paul Christiano](https://www.lesswrong.com/posts/2NncxDQ3KBDCxiJiP/cosmopolitan-values-don-t-come-free?commentId=7FWtKMtGEmj58egqL): “I think that normal people \[would say\]: ‘If we are trying to help some creatures, but those creatures really dislike the proposed way we are “helping” them, then we should try a different tactic for helping them.’”

He’s right: normal people would definitely say that, and our human Approval Reward is why we would say that. And if AGI likewise has Approval Reward (or something like it), then the AGI would presumably share that intuition.

On the other hand, if Approval Reward is *not* part of AGI / ASI, then we’re instead in the “corrigibility is anti-natural” school of thought in AI alignment. As an example of that school of thought, see [Why Corrigibility is Hard and Important](https://www.lesswrong.com/posts/ksfjZJu3BFEfM6hHE/why-corrigibility-is-hard-and-important-i-e-whence-the-high).

# 4. The human intuition that unorthodox consequentialist planning is rare and sus

Obviously, humans can make long-term plans to accomplish distant goals—for example, an 18-year-old could plan to become a doctor in 15 years, and immediately move this plan forward via sensible consequentialist actions, like taking a chemistry class.

![](https://res.cloudinary.com/lesswrong-2-0/image/upload/f_auto,q_auto/v1/mirroredImages/d4HNRdw6z7Xqbnu5E/wc63g8z7cdmg8aw4osq0)

Even if a young child wants to grow up to become a doctor, they can and will take appropriate goal-oriented actions to advance this long-term plan, such as practicing surgical techniques (left) and watching training videos (right).

How does that work in the 18yo’s brain? Obviously not via anything like RL techniques that we know and love in AI today—for example, it does *not* work by episodic RL with an absurdly-close-to-unity [discount factor](https://en.wikipedia.org/w/index.php?title=Q-learning&oldid=1311484908#Discount_factor) that allows for 15-year time horizons. Indeed, the discount factor / time horizon is clearly irrelevant here! This 18yo has never become a doctor before!

Instead, there has to be something motivating the 18yo *right now* to take appropriate actions towards becoming a doctor. And in practice, I claim that that “something” is almost always an immediate Approval Reward signal.

Here’s another example. Consider someone saving money today to buy a car in three months. You might think that they’re doing something unpleasant now, for a reward later. But I claim that that’s unlikely. Granted, saving the money has immediately-unpleasant aspects! But saving the money also has even stronger immediately-pleasant aspects—namely, that the person feels pride in what they’re doing. They’re probably telling their friends periodically about this great plan they’re working on, and the progress they’ve made. Or if not, they’re probably at least *imagining* doing so.

So saving the money is *not* doing an unpleasant thing now for a benefit later. Rather, the pleasant feeling starts immediately, thanks to (usually) Approval Reward.

Moreover, everyone has gotten very used to this fact about human nature. Thus, doing the first step of a long-term plan, *without* Approval Reward for that first step, is so rare that people generally regard it as highly suspicious. They generally assume that there *must* be an Approval Reward. And if they can’t figure out what it is, then there’s something important about the situation that you’re not telling them. …Or maybe they’ll assume that you’re a Machiavellian sociopath.

As an example, I like to bring up Earning To Give (EtG) in Effective Altruism, the idea of getting a higher-paying job in order to earn money and give it to charity. If you tell a normal non-nerdy person about EtG, they’ll generally assume that it’s an obvious lie, and that the person actually wants the higher-paying job for its perks and status. That’s how weird it is—it doesn’t even cross most people’s minds that someone is actually doing a socially-frowned-upon plan because of its expected long-term consequences, unless the person is a psycho. …Well, that’s less true now than a decade ago; EtG has become more common, probably because (you guessed it) there’s now a community in which EtG is socially admirable.

Related: there’s a [fiction trope](https://tvtropes.org/pmwiki/pmwiki.php/Main/VillainsActHeroesReact) that basically only villains are allowed to make out-of-the-box plans and display intelligence. The normal way to write a hero in a work of fiction is to have conflicts between doing things that have strong immediate social approval, versus doing things for other reasons (e.g. fear, hunger, logic(!)), and to have the former win out over the latter in the mind of the hero. And then the hero pursues the immediate-social-approval option with *such gusto* that everyone lives happily ever after.[^9]

That’s all in the human world. Meanwhile in AI, the alignment-is-hard thinkers like me generally expect that future powerful AIs will lack Approval Reward, or anything like it. Instead, they generally assume that the agent will have preferences about the future, and make decisions so as to bring about those preferences, not just as a tie-breaker on the margin, but as the main event. Hence [instrumental convergence](https://www.lesswrong.com/w/instrumental-convergence). I think this is exactly the right assumption (in the absence of a specific designed mechanism to prevent that), but I think people react with disbelief when we start describing how these AI agents behave, since it’s so different from humans.

…Well, different from most humans. Sociopaths can be a bit more like that (in certain ways). Ditto people who are unusually [“agentic”](https://usefulfictions.substack.com/p/how-to-be-more-agentic). And by the way, how do you help a person become “agentic”? You guessed it: a key ingredient is calling out “being agentic” as a meta-level behavioral pattern, and indicating to this person that following this meta-level pattern will get social approval! (Or at least, that it won’t get social disapproval.)

# 5. The human intuition that societal norms and institutions are mostly stably self-enforcing

## 5.1 Detour into “Security-Mindset Institution Design”

There’s an attitude, common in the crypto world, that we might call [“Security-Mindset](https://www.lesswrong.com/posts/8gqrbnW758qjHFTrH/security-mindset-and-ordinary-paranoia) Institution Design”. You assume that every surface is an attack surface. You assume that everyone is a potential thief and traitor. You assume that any group of people might be colluding against any other group of people. And so on.

It is *extremely* hard to get anything at all done in “Security-Mindset Institution Design”, especially when you need to interface with the real-world, with all its rich complexities that cannot be bounded by cryptographic protocols and decentralized verification. For example, crypto [Decentralized Autonomous Organizations](https://en.wikipedia.org/wiki/Decentralized_autonomous_organization) (DAOs) don’t seem to have done much of note in their decade of existence, apart from on-chain projects, and occasionally getting catastrophically hacked. Polymarket has a nice on-chain system, right up until the moment that a prediction market needs to resolve, and even this tiny bit of contact with the real world seems to be a problematic source of [vulnerabilities](https://www.reddit.com/r/ethereum/comments/1gi7z5s/comment/lv3wqc2/).

If you extend this “Security Mindset Institution Design” attitude to an actual fully-real-world government and economy, it would be beyond hopeless. Oh, you have an alarm system in your house? Why do you trust that the alarm system company, or its installer, is not out to get you? Oh, the company has a good reputation? According to who? And how do you know *they’re* not in cahoots too?

…That’s just one tiny microcosm of a universal issue. Who has physical access to weapons? Why don’t those people collude to set their own taxes to zero and to raise everyone else’s? Who sets government policy, and what if those people collude against everyone else? Or even if they don’t collude, are they vulnerable to blackmail? Who counts the votes, and will they join together and start soliciting bribes? Who coded the website to collect taxes, and why do we trust them not to steal tons of money and run off to Dubai?

![](https://res.cloudinary.com/lesswrong-2-0/image/upload/f_auto,q_auto/v1/mirroredImages/d4HNRdw6z7Xqbnu5E/dvwuzggwqqqfjdlhunfl)

[Source](https://en.wikipedia.org/wiki/Homer_the_Vigilante)

…OK, you get the idea. That’s the “Security Mindset Institution Design” perspective.

## 5.2 The load-bearing ingredient in human society is not Security-Mindset Institution Design, but rather good-enough institutions plus almost-universal human innate Approval Reward

Meanwhile, ordinary readers[^10] might be shaking their heads and saying:

*“Man, what kind of strange alien world is being described in that subsection above? High-trust societies with robust functional institutions are obviously possible! I live in one!”*

***The wrong answer*** is: “Security Mindset Institution Design is insanely overkill; rather, using checks and balances to make institutions stable against defectors is in fact a very solvable problem in the real world.”

Why is that the wrong answer? Well for one thing, if you look around the real world, even well-functioning institutions are *obviously* not robust against competent self-interested sociopaths willing to burn the commons for their own interests. For example, I happen to have a [high-functioning sociopath ex-boss from long ago](https://forum.effectivealtruism.org/posts/4LNiPhP6vw2A5Pue3/consider-granting-ais-freedom?commentId=SdCJGfEhTC3numKB2). Where is he now? Head of research at a major USA research university, and occasional government appointee wielding immense power. Or just look at how Donald Trump has been systematically working to undermine any aspect of society or government that might oppose his whims or correct his lies.[^11]

For another thing, abundant “nation-building” experience shows that you cannot simply bestow a “good” government constitution onto a deeply corrupt and low-trust society, and expect the society to instantly transform into Switzerland. Institutions and laws are not enough. There’s also an arduous and fraught process of getting to the right social norms. Which brings us to:

***The right answer*** is, you guessed it, human Approval Reward, a consequence of which is that *almost all humans are intrinsically motivated to follow and enforce social norms*. The word “intrinsically” is important here. I’m not talking about transactionally following norms when the selfish benefit outweighs the selfish cost, while constantly energetically searching for norm-violating strategies that might change that calculus. Rather, people *take pride* in following the norms, and in punishing those who violate them.

Obviously, any possible system of norms and institutions will be vastly easier to stabilize when, no matter what the norm is, you can get up to ≈99% of the population proudly adopting it, and then spending their own resources to root out, punish, and shame the 1% of people who undermine it.

In a world like that, it is hard but doable to get into a stable situation where 99% of cops aren’t corrupt, and 99% of judges aren’t corrupt, and 99% of people in the military with physical access to weapons aren’t corrupt, and 99% of IRS agents aren’t corrupt, etc. The last 1% will still create problems, but the other 99% have a fighting chance to keep things under control. Bad apples can be discovered and tossed out. Chains of trust can percolate.

## 5.3 Upshot

Something like 99% of humans are intrinsically motivated to follow and enforce norms, with the rest being sociopaths and similar. What about future AGIs? As discussed in §0.2, my own expectation is that 0% of them will be intrinsically motivated to follow and enforce norms. When those sociopathic AGIs grow in number and power, it takes us from the familiar world of §5.2 to the paranoid insanity world of §5.1.

In that world, we really shouldn’t be using the word “norm” at all—it’s just misleading baggage. We should be talking about *rules that are stably self-enforcing against defectors*, where the “defectors” are of course allowed to include those who are supposed to be doing the enforcement, and where the “defectors” might also include broad coalitions coordinating to jump into a new equilibrium that Pareto-benefits them all. We do not have such self-enforcing rules today. Not even close. And we never have. And inventing such rules is a pipe dream.[^12]

The flip side, of course, is that if we figure out how to ensure that almost all AGIs *are* intrinsically motivated to follow and enforce norms, then it’s the pessimists who are invoking a misleading mental image if they lean on §5.1 intuitions.

# 6. The human intuition that treating other humans as a resource to be callously manipulated and exploited, just like a car engine or any other complex mechanism in their environment, is a weird anomaly rather than the obvious default

Click over to [Foom & Doom §2.3.4—“The naturalness of egregious scheming: some intuitions”](https://www.lesswrong.com/posts/bnnKGSCHJghAvqPjS/foom-and-doom-2-technical-alignment-is-hard#2_3_4_The_naturalness_of_egregious_scheming__some_intuitions) to read this part.

# 7. Conclusion

(Homework: can you think of more examples?)

I want to reiterate that my main point in this post is not

> *Alignment is hard and we’re doomed because future AIs definitely won’t have Approval Reward (or something similar).*

but rather

> *There’s a QUESTION of whether or not alignment is hard and we’re doomed, and many cruxes for this question seem to be downstream of the narrower question of whether future AIs will have Approval Reward (or something similar) (§0.2). I am surfacing this latent uber-crux to help advance the discussion*.

For my part, I’m obviously very interested in the question of whether we can and should put Approval Reward (and [Sympathy Reward](https://www.lesswrong.com/posts/KuBiv9cCbZ6ALjHFw/social-drives-1-sympathy-reward-from-compassion-to)) into Brain-Like AGI, and what might go right and wrong if we do so. More on that in (hopefully) upcoming posts!

*Thanks Seth Herd, Linda Linsefors, Charlie Steiner, Simon Skade, Jeremy Gillen, and Justis Mills for critical comments on earlier drafts.*

[^1]:
	…and by extension today’s LLMs, [which (I claim) get their powers mainly from imitating humans](https://www.lesswrong.com/posts/bnnKGSCHJghAvqPjS/foom-and-doom-2-technical-alignment-is-hard#2_3_1__Where_do_you_get_your_capabilities_from__).
[^2]:
	I said “surreptitiously” here because if you *ostentatiously* press a reward button, in a way that the robot can see, then the robot would presumably wind up wanting the reward button to be pressed, which eventually leads to the robot grabbing the reward button etc. See [Reward button alignment](https://www.lesswrong.com/posts/JrTk2pbqp7BFwPAKw/reward-button-alignment).
[^3]:
	See [Perils of under- vs over-sculpting AGI desires](https://www.lesswrong.com/posts/grgb2ipxQf2wzNDEG/perils-of-under-vs-over-sculpting-agi-desires), especially [§7.2](https://www.lesswrong.com/posts/grgb2ipxQf2wzNDEG/perils-of-under-vs-over-sculpting-agi-desires#7_2_Relation_to_the_traditional_overfitting_problem), for why the “nice” desire would not even be temporarily learned, and if it were it would be promptly unlearned; and see [“Behaviorist” RL reward functions lead to scheming](https://www.lesswrong.com/posts/FNJF3SoNiwceAQ69W/behaviorist-rl-reward-functions-lead-to-scheming) for some related intuitions; and see [§3.2 of the Approval Reward post](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to#3_2_The_habit_of_imagining_how_one_looks_in_other_people_s_eyes__10_000_times_a_day) for why those don’t apply to (non-behaviorist) Approval Reward.
[^4]:
	My own take, which I won’t defend here, is that this whole debate is cursed, and both sides are confused, because LLMs cannot scale to AGI. I think the AGI concerns really are unsolved, and I think that LLM techniques really are potentially-safe, but they are potentially-safe *for the very reason* that they won’t lead to AGI. I think “LLM AGI” is an incoherent contradiction, like “square circle”, and one side of the debate has a mental image of “square thing (but I guess it’s somehow also a circle)”, and the other side of the debate has a mental image of “circle (but I guess it’s somehow also square)”, so no wonder they talk past each other. So that’s how things seem to me right now. Maybe I’m wrong!! But anyway, that’s why I feel unable to take a side in this particular debate. I’ll leave it to others. See also: [Foom & Doom §2.9.1](https://www.lesswrong.com/posts/bnnKGSCHJghAvqPjS/foom-and-doom-2-technical-alignment-is-hard#2_9_1_If_brain_like_AGI_is_so_dangerous__shouldn_t_we_just_try_to_make_AGIs_via_LLMs_).
[^5]:
	…as long as the meta-preferences-about-desire-changes are changing in a way that seems good according to those same meta-preferences themselves—growth good, brainwashing bad, etc.
[^6]:
	Possible objection: “If the RL agent has lots of past experience of its reward function periodically changing, won’t it learn that this is good?” My answer: No. At least for [the kind of model-based RL agent that I generally think about](https://www.lesswrong.com/posts/vpdJz4k5BgGzuGo7A/intro-to-brain-like-agi-safety-9-takeaways-from-neuro-2-2-on), the reward function creates desires, and the desires guide plans and actions. So at any given time, there are still desires, and if these desires concern the state of the world in the future, then the instrumental convergence argument for goal-preservation goes through as usual. I see no process by which past history of reward function changes should make an agent OK with further reward function changes going forward.
	(But note that the instrumental convergence argument makes model-based RL agents want to preserve their current *desires*, not their current *reward function*. For example, if an agent has a wireheading desire to get reward, it will want to self-modify to *preserve* this desire while *changing* the reward function to “return +∞”.)
[^7]:
	…At least to a first approximation. Here are some technicalities: (1) Other pathways also exist, and *can* generate a force for desire preservation. (2) There’s also a loopy thing where Approval Reward influences self-reflective desires, which in turn influence Approval Reward, e.g. by changing who you admire. (See [Approval Reward post §5](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to#5__Approval_Reward___Typical_Mind_Fallacy____reward_for_sharing_special_interests_)–[§6](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to#6__How_robust_are_the_effects_of_Approval_Reward_).) This can (mildly) lock in desires. (3) Even Approval Reward itself leads *not only* to “proud feeling about what I’m up to right now” ([Approval Reward post §3.2](https://www.lesswrong.com/posts/fPxgFHfs5yHzYqgG7/social-drives-2-approval-reward-from-norm-enforcement-to#3_2_The_habit_of_imagining_how_one_looks_in_other_people_s_eyes__10_000_times_a_day)), which does not particularly induce desire-preservation, *but also* to “desire to actually interact with and impress a real live human sometime in the future”, which is on the left side of that figure in §0.3, and which (being [consequentialist](https://www.lesswrong.com/posts/KDMLJEXTWtkZWheXt/consequentialism-and-corrigibility)) *does* induce desire-preservation and the other instrumental convergence stuff.
[^8]:
	If an Approval-Reward-free AGI wants X and wants Y, then it could get more X by no longer wanting Y, and it could get more Y by no longer wanting X. So there’s a possibility that AGI reflection could lead to “total victory” where one desire erases another. But I (tentatively) think that’s unlikely, and that the more likely outcome is that the AGI would continue to want both X and Y, and to split its time and resources between them. A big part of my intuition is: you can theoretically have a consequentialist utility-maximizer with utility function U\=log(X)+log(Y) , and it will generally split its time between X and Y forever, and [this agent is reflectively stable](https://www.lesswrong.com/w/consequentialist-preferences-are-reflectively-stable-by). (The logarithm ensures that X and Y have diminishing returns. Or if that’s not diminishing *enough*, consider U\=loglogX+loglogY, etc.)
[^9]:
	To show how widespread this is, I don’t want to cherry-pick, so my two examples will be the two most recent movies that I happen to have watched, as I’m sitting down to write this paragraph. These are: [Avengers: Infinity War](https://en.wikipedia.org/wiki/Avengers:_Infinity_War) & [Ant-Man and the Wasp](https://en.wikipedia.org/wiki/Ant-Man_and_the_Wasp). (Don’t judge, I like watching dumb action movies while I exercise.)
	*Spoilers for the Marvel Cinematic Universe film series (pre-2020) below:*
	The former has a wonderful example. The heroes can definitely save trillions of lives by allowing their friend Vision to sacrifice his life, which by the way he is begging to do. They refuse, instead trying to save Vision *and* save the trillions of lives. As it turns out, they fail, and both Vision and the trillions of innocent bystanders wind up dead. Even so, this decision is portrayed as good and proper heroic behavior, and is never second-guessed even after the failure. (Note that “Helping a friend in need who is standing right there” has very strong immediate social approval for reasons explained in [§6 of Social drives 1 (“Sympathy Reward strength as a character trait, and the Copenhagen Interpretation of Ethics”)](https://www.lesswrong.com/posts/KuBiv9cCbZ6ALjHFw/social-drives-1-sympathy-reward-from-compassion-to#6__Sympathy_Reward_strength_as_a_character_trait__and_the_Copenhagen_Interpretation_of_Ethics).) (Don’t worry, in a sequel, the plucky heroes travel back in time to save the trillions of innocent bystanders after all.)
	In the latter movie, nobody does anything quite as outrageous as that, but it’s still true that pretty much every major plot point involves the protagonists risking themselves, or their freedom, or the lives of unseen or unsympathetic third parties, in order to help their friends or family in need—which, again, has very strong immediate social approval.
[^10]:
	And [@Matthew Barnett](https://www.lesswrong.com/users/matthew-barnett?mention=user)! This whole section is based on (and partly copied from) [a comment thread last year between him and me](https://forum.effectivealtruism.org/posts/4LNiPhP6vw2A5Pue3/consider-granting-ais-freedom?commentId=SdCJGfEhTC3numKB2).
[^11]:
	…in a terrifying escalation of a long tradition that both USA parties have partaken in. E.g. if you want examples of the Biden administration recklessly damaging longstanding institutional norms, see [1](https://en.wikipedia.org/w/index.php?title=Equal_Rights_Amendment&oldid=1318748378#Biden_declaration), [2](https://en.wikipedia.org/wiki/Murthy_v._Missouri). (Pretty please don’t argue about politics in the comments section.)
[^12]:
	Superintelligences might be able to design such rules amongst themselves, for all I know, although it would probably involve human-incompatible things like “merging” (jointly creating a successor ASI then shutting down). Or we might just get a unipolar outcome in the first place (e.g. many copies of one ASI with the same non-indexical goal), for reasons discussed in my post [Foom & Doom §1.8.7](https://www.lesswrong.com/posts/yew6zFWAKG4AGs3Wk/foom-and-doom-1-brain-in-a-box-in-a-basement#1_8_7_Decisive_Strategic_Advantage__DSA__seems_hard_to_avoid).