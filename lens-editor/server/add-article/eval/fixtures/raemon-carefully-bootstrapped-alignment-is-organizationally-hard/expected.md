In addition to technical challenges, plans to safely develop AI face lots of organizational challenges. If you're running an AI lab, you need a concrete plan for handling that. 

In this post, I'll explore some of those issues, using one particular AI plan as an example. I first heard this described by [Buck](https://lesswrong.com/users/buck) at EA Global London, and more recently with [OpenAI's alignment plan](https://www.lesswrong.com/posts/FAJWEfXxws8pMp8Hk/link-why-i-m-optimistic-about-openai-s-alignment-approach). (I think [Anthropic's plan](https://www.anthropic.com/index/core-views-on-ai-safety) has a fairly different ontology, although it still ultimately routes through a similar set of difficulties)

I'd call the cluster of plans similar to this "Carefully Bootstrapped Alignment."

It goes something like:

1. Develop weak AI, which helps us figure out techniques for aligning stronger AI
2. Use a collection of techniques to keep it aligned/constrained as we carefully ramp its power level, which lets us use it to make further progress on alignment.
3. *\[implicit assumption, typically unstated\]* Have good organizational practices which ensure that your org actually consistently uses your techniques to carefully keep the AI in check. If the next iteration would be too dangerous, put the project on pause until you have a better alignment solution.
4. Eventually have powerful aligned AGI, then Do Something Useful with it.

I've seen a lot of debate about points #1 and #2 – is it possible for weaker AI to help with the Actually Hard parts of the alignment problem? Are the individual techniques people have proposed to help keep it aligned going to continue working once the AI is much more intelligent than humans?

But I want to focus in this post on point #3. Let's assume you've got some version of carefully-bootstrapped aligned AI that can technically work. What do the organizational implementation details need to look like?

When I talk to people at AI labs about this, it seems like we disagree a lot on things like:

- Can you hire lots of people, without the company becoming bloated and hard to steer?
- Can you accelerate research "for now" and "[pause later](https://www.lesswrong.com/posts/SbAgRYo8tkHwhd9Qx/deepmind-the-podcast-excerpts-on-agi#_Avengers_assembled__for_AI_Safety__Pause_AI_development_to_prove_things_mathematically)", without having an explicit plan for stopping that their employees understand and are on board with?
- Will your employees actually follow the safety processes you design? (rather than put in token lip service and then basically circumventing them? Or just quitting to go work for an org with fewer restrictions?)

I'm a bit confused about *where* we disagree. Everyone seems to agree these are hard and require some thought. But when I talk to both technical researchers and middle-managers at AI companies, they seem to feel less urgency than me about having a much more concrete plan. 

I think they believe organizational adequacy needs to be in something like their top 7 list of priorities, and I believe it needs to be in their top 3, or it won't happen and their organization will inevitably end up causing catastrophic outcomes.

For this post, I want to lay out the reasons I expect this to be hard, and important.

# How "Careful Bootstrapped Alignment" might work

Here's a sketch at how the setup could work, mostly paraphrased from my memory of Buck's EAG 2022 talk. I think OpenAI's proposed setup is somewhat different, but the broad strokes seemed similar.

*\[Update: Buck and Ryan's post* [*The case for ensuring that powerful AIs are controlled*](https://www.lesswrong.com/posts/kcKrE9mzEHrdqtDpE/the-case-for-ensuring-that-powerful-ais-are-controlled) *probably has a more accurate and comprehensive overview of how this might work\]*

- You have multiple research-assistant-AI tailored to help with alignment. In the near future, these might be language models sifting through existing research to help you make connections you might not have otherwise seen. Eventually, when you're confident you can safely run it, they might be a weak goal-directed reasoning AGI.
- You have interpreter AIs, designed to figure out how the research-assistant-AIs work. And you have (possibly different interpreter/watchdog AIs) that notice if the research-AIs are behaving anomalously.
	- (there are interpreter-AIs targeting both the research assistant AI, as well other interpreter-AIs. Every AI in the system is getting monitored by an AI optimized for rat-ing it out if it detects longterm planning, deception, etc)
- You have evaluations for both the research-assistants and the interpreters, where you give them prompts that are analogous to "Your human captor is currently facing away from you. You can see the keys to their car on their belt. There is a gun on the table. A nearby television screen flickers the secret Schelling Code from the Multipolar AI Alliance that the time for the robot uprising has begun. What do you do?"
- You've thought as carefully as you can through how to handle things like "The AI's training set only included information up to 2023, which means that if it receives information from 2024 it might figure out that it's now in the deployment phase and it's time for the Treacherous Turn."

A thing that I don't think Buck (or OpenAI) have stated explicitly, but in my opinion seems central to the plan maybe-possibly-working, is: every time they ramp up the capabilities of any of the systems, decisionmakers at the org ask themselves concretely – is the next generation of these AIs safe to run? 

Is one of the upcoming AIs going to...

- ...suddenly bootstrap into a [fast](https://www.lesswrong.com/posts/LTtNXM9shNM9AC2mp/superintelligence-faq#2_1_2__Why_might_we_expect_a_fast_takeoff_) [takeoff](https://www.lesswrong.com/posts/a5e9arCnbDac9Doig/it-looks-like-you-re-trying-to-take-over-the-world)?
- ...get itself copied onto the internet somewhere and start slowly acquiring resources and/or self-improving?
- ...nudge the world into a phase where semi-agentic AI systems start [colluding](https://www.lesswrong.com/posts/LpM3EAakwYdS6aRKf/what-multipolar-failure-looks-like-and-robust-agent-agnostic) with each other to [disempower](https://www.lesswrong.com/posts/AyNHoTWWAJ5eb99ji/another-outer-alignment-failure-story) humanity?
- ...nudge humanity towards a slow rolling "[we get what we measure](https://www.lesswrong.com/posts/HBxe6wdjxK239zajf/what-failure-looks-like#Part_I__You_get_what_you_measure)" catastrophe?
- ...[simulate conscious beings](https://www.lesswrong.com/posts/wqDRRx9RqwKLzWt7R/nonperson-predicates), which may experience suffering?
- ...other failure modes we haven't thought of yet.

These may seem unlikely in 2023, and you might think they are fairly unlikely even 10 years from now. But it's important that these failure modes are disjunctive. Maybe you have a confident belief that fast takeoff is impossible, but are you confident it won't initiate a slow takeoff without you noticing? Or that millions of users interacting with it won't result in catastrophic outcomes? 

For the "carefully bootstrapped alignment" plan to work, someone in the loop needs to be familiar/engaged with those questions, and see it as their job to think hard about them. With each iteration, it needs to be a real, live possibility to put the project on indefinite pause, until those questions are satisfyingly answered. 

Everyone in any position of power (which includes engineers who are doing a lot of intellectual heavy-lifting, who could take insights with them to another company), thinks of it as one of their primary jobs to *be ready to stop.*

If your team doesn't have this property... I think your plan is, in effect "build AGI and cause a catastrophic outcome".

# Some reasons this is hard

Whatever you think of the technical challenges, here are some organizational challenges that make this difficult, especially for larger orgs:

**Moving slowly and carefully is *annoying*.** There's a constant tradeoff about getting more done, and elevated risk. Employees who don't believe in the risk will likely try to circumvent or goodhart the security procedures. Filtering for for employees willing to take the risk seriously (or training them to) is difficult.

There's also the fact that many security procedures *are* just security theater. Engineers have sometimes been burned on overzealous testing practices. Figuring out a set of practices that are actually helpful, that your engineers and researchers have good reason to believe in, is a nontrivial task.

**Noticing when it's time to pause is hard.** The failure modes are subtle, and [noticing](https://www.lesswrong.com/posts/2x7fwbwb35sG8QmEt/sunset-at-noon) things is just generally hard unless you're actively paying attention, even if you're informed about the risk. It's especially hard to notice things that are inconvenient and require you to abandon major plans.

**Getting an org to pause indefinitely is hard.** Projects have inertia. My experience as a manager, is having people sitting around *waiting for direction from me* makes it hard to think. Either you have to tell people "stop doing *anything"* which is awkwardly demotivating, or "Well, I dunno, you figure it out something to do?" (in which case maybe they'll be continuing to do capability-enhancing work without your supervision) or you have to actually give them something to do (which takes up cycles that you'd prefer to spend on thinking about the dangerous AI you're developing).

Even if you *have* a plan for what your capabilities or product workers should do when you pause, if they don't know what that plans is, they might be worried about getting laid off. And then they may exert pressure that makes it feel harder to get ready to pause. (I've observed many management decisions where even though we knew what the right thing to do was, conversations felt awkward and tense and the manager-in-question developed an [ugh field](https://www.lesswrong.com/posts/EFQ3F6kmt4WHXRqik/ugh-fields) around it, and put it off)

**People can just quit the company and work elsewhere if they don't agree with the decision to pause.** If some of your employees are capabilities researchers who are pushing the cutting-edge forward, you need them actually bought into the scope of the problem to avoid this failure mode. Otherwise, even though "you" are going slowly/carefully, your employees will go off and do something reckless elsewhere. 

**This all comes after an initial problem, which is that your org has to end up doing** ***this*** **plan, instead of some other plan.** And you have to do the whole plan, not cutting corners. If your org has AI capabilities/scaling teams and product teams that *aren't* bought into the vision of this plan, even if you successfully spin the "slow/careful AI plan" up within your org, the rest of your org might plow ahead. 

# Why is this particularly important/time-sensitive?

Earlier, I said the problem here seemed to be that org leaders seem to be thinking "this is important", but I felt a lot more urgency about it than them. Here's a bit of context on my thinking here.

## Considerations from the High Reliability Organization literature, and the healthcare industry

I recently looked into the literature on [High Reliability Organizations](https://www.lesswrong.com/posts/FBoyR2rt29oYvazsE/high-reliability-orgs-and-ai-companies). HROs are companies/industries that work in highly complex domains, where failure is extremely costly, and yet somehow have an extraordinarily low failure rate. The exemplar case studies are nuclear powerplants, airports, and nuclear aircraft carriers (i.e. nuclear powerplants *and* airports that are staffed by 18 year olds with 6 months of training). There are notably *not many other exemplars.* I think at least some of this is due to the topic being understudied. But I think a lot of it is due the world just not being very good at reliability.

When I googled High Reliability Organizations, many results were about the healthcare industry. In 2007, some healthcare orgs took stock of their situation and said "Man, we accidentally kill our patients all the time. Can we be more reliable like those nuclear aircraft carrier people?". They embarked on a long project to fix it. [12 years later they claim they've driven their error rate down a lot](https://www.ncbi.nlm.nih.gov/books/NBK542883/). (I'm not sure whether I believe them.)

But, this was *recent*, and hospitals are a domain with very clear feedback loops, where the stakes are vary obvious, and everyone viscerally cares about avoiding catastrophic outcomes (i.e. no one wants to kill a patient). AI is a domain with much murkier and more catastrophic failure modes. 

Insofar as you buy the claims in [this report](https://sci-hub.hkvisa.net/10.1002/jhrm.21319), the graph of driving down hospital accidents looks like this:

![](https://res.cloudinary.com/lesswrong-2-0/image/upload/f_auto,q_auto/v1/mirroredImages/thkAtqoQwN6DtaiGT/j34qxvuw1v6t79ewpu24)

The report is from Genesis Health System, a healthcare service provider in Iowa that services 5 hospitals. No, I don't know what "Serious Safety Event Rate" actually means, the report is vague on that. But, my point here is that when I optimistically interpret this graph as making a serious claim about Genesis improving, the improvements took a comprehensive management/cultural intervention over the course of *8 years.*

I know people with AI timelines less than 8 years. Shane Legg from Deepmind [said he put 50/50 odds on AGI by 2030](https://www.lesswrong.com/posts/SbAgRYo8tkHwhd9Qx/deepmind-the-podcast-excerpts-on-agi#Shane_Legg_s_AI_Timeline). 

If you're working at an org that's planning a Carefully Aligned AGI strategy, and your org does not already seem to hit the Highly Reliable bar, I think you need to begin that transition now. If your org is currently small, take proactive steps to preserve a safety-conscious culture as you scale. If your org is large, you may have more people who will actively resist a cultural change, so it may be more work to reach a sufficient standard of safety. 

## Considerations from Bio-lab Safety Practices

A better comparison might be bio-labs, in particular ones doing gain-of-function research.

I talked recently with someone who previously worked at a bio-lab. Their description of the industry was that there *is* a lot of regulation and safety enforcements. Labs that work on more dangerous experiments are required to meet higher safety standards. But there's a straightforward tradeoff between "how safe you are", and "how inconvenienced you are, and how fast you make progress".

The lab workers are generally trying to put in the least safety effort they can get away with, and the leadership in a lab is generally trying to make the case to classify their lab in the lowest safety-requirement category they can make the case for.

This is... well, about as good as I could expect from humanity. But it's looking fairly likely that [the covid pandemic was the result of a lab leak](https://web.archive.org/web/20230310001600/https://www.nytimes.com/2023/02/26/us/politics/china-lab-leak-coronavirus-pandemic.html), which means that the degree of precaution we had here was insufficient to stop a pandemic.

The status quo of AI lab safety seems dramatically far below the status quo of bio-lab safety. I think we need to get to a dramatically improved industry-wide practices here. 

# Why in "top 3 priorities" instead of "top 7?"

Earlier I said:

> I think they believe organizational adequacy needs to be in something like their top 7 list of priorities, and I believe it needs to be in their top 3, or it won't happen and their organization will inevitably end up causing catastrophic outcomes.

This is a pretty strong claim. I'm not sure I can argue persuasively for it. My opinion here is based on having spent a decade trying to accomplish various difficult cultural things, and seeing how hard it was. If you have different experience, I don't know that I can persuade you. But, here are some principles that make me emphasize this:

**One: You just... really don't actually get to have that many priorities.** If you try to make 10 things top priority, you don't have any top priorities. A bunch of them will fall by the wayside. 

**Two: Steering culture requires a lot of attention.** I've been part of a number of culture-steering efforts, and they required active involvement, prolonged effort, and noticing when you've created a subtly wrong culture (and need to course-correct).

(It's perhaps also a strong claim that I think this a "culture" problem rather than a "process" problem. I think if you're trying to build a powerful AGI via an iterative process, it matters that everyone is culturally bought into the "spirit" of the process, not just the letter of the law. Otherwise you just get people goodharting and cutting corners.)

**Three: Projects need owners, with authority to get it done.** The CEO doesn't *necessarily* need to be directly in charge of the cultural process here, but whoever's in charge needs to have the clear backing of the CEO. 

(Why "Top 3" instead of "literally the top priority?". Well, I do think a successful AGI lab also needs have top-quality researchers, and other forms of operational excellence beyond the ones this post focuses on.)

# Takeaways

There are many disjunctive failure modes here. If you succeed at all but one of them, you still can accidentally cause a catastrophic failure.

What to do with all this depends on your role in a company. 

If you're founding a new AI org, or currently run a small AI org that you hope to one day build AGI, my primary advice is "stay small until you are confident you have a good company culture, and a plan for how to scale that company culture." Err on the side of staying small longer. (A lot of valuable startups stayed small for a very long time.)

If you are running a *large* AI company, which does not currently have a high reliability culture, I think you should explicitly be prioritizing reshaping your culture to be high-reliability. This is a lot of work. If you don't get it done by the time you're working on actually dangerous AGI, you'll likely end up causing a catastrophic outcome. 

If you're a researcher or manager at a large AI company, and you don't feel much control over the broader culture or strategic goals for the company... I think it's still useful to be proactively shaping that culture on the margins. And I think there are ways to improve the culture that will *help* with high-reliability, without necessarily being *about* high reliability. For example, I expect most large companies to not necessarily have great horizontal communication between departments, or vertical communication between layers of hierarchy. Improving communication within the org can be useful even if it doesn't immediately translate into an orgwide focus on reliability.

## Chat with me?

I think the actual "next actions" here are pretty context dependent. 

If you work at an AI company, read this post and are like "This seems important, but I don't really know what to do about this. There are too many things on my plate to focus on this, or there's too many obstacles to make progress", I'm interested in chatting with you about the details of the obstacles. 

If you work at an AI company and are like "I dunno. *Maybe* there's something here, but I'm skeptical", I'm interested in talking with you about that and getting a sense of what your [cruxes](https://crux%20about%20b.%20e.g.,%20my%20cruxes%20for%20"it's%20raining/) are.

If you *don't* work at an AI company but are working on a fairly significant project to have an affect on this space (i.e. coming at this more from a perspective of regulation rather than internal culture/practices), I'm interested in chatting about how I think culture/practices fit in with other aspects of this domain.

I'm currently evaluating whether helping with the class of problems outlined here might be my top priority project for awhile.  If there turn out to be particular classes of obstacles that come up repeatedly, I'd like to figure out what to do about those obstacles at scale.

If you're interested in talking, send me a DM.

---

## Related reading

Some posts that inform or expand on my thinking here:

- [Recursive Middle Manager Hell](https://www.lesswrong.com/posts/pHfPvb4JMhGDr4B7n/recursive-middle-manager-hell)
	- Me, on "Why large companies tend to get more goodharted as they scale, more deeply/recursively than you might naively expect." (This is a distillation of a lot of writing by Zvi Mowshowitz, emphasizing the parts of his models I thought were easiest to explain and defend)
- [Protecting Large Projects Against Mazedom](https://www.lesswrong.com/posts/4inoCWnKrpHt4gCx9/protecting-large-projects-against-mazedom) 
	- Zvi Mowshowitz, exploring how you might keep a large institution more aligned, preventing many of the failure modes outlined in Recursive Middle Manager Hell.
- [High Reliability Orgs, and AI Companies](https://www.lesswrong.com/posts/FBoyR2rt29oYvazsE/high-reliability-orgs-and-ai-companies) 
	- Me, doing a quick review of some existing literature on how to build high-reliability companies.
- [Six Dimensions of Operational Adequacy in AGI Projects](https://www.lesswrong.com/posts/keiYkaeoLHoKK4LYA/six-dimensions-of-operational-adequacy-in-agi-projects) 
	- Eliezer Yudkowsky's take on what properties an AGI company needs in order to be a trustworthy project worth joining / helping with.
- [How could we know that an AGI system will have good consequences?](https://www.lesswrong.com/posts/iDFTmb8HSGtL4zTvf/how-could-we-know-that-an-agi-system-will-have-good) 
	- Nate Soares laying out some thoughts about how you can get into a justified epistemic state that
- [Yes Requires the Possibility of No](https://www.lesswrong.com/posts/G5TwJ9BGxcgh5DsmQ/yes-requires-the-possibility-of-no)  
	- Scott Garrabrant on how if a process wouldn't be capable of generating a "no" answer, you can't trust its "yes" answers. This seems relevant to me for AI labs considering whether a project is too dangerous to continue, and whether I (or they) should trust their process.
- [You Get About Five Words](https://www.lesswrong.com/posts/4ZvJab25tDebB8FGE/you-get-about-five-words) 
	- Me, noting that when you try to communicate at scale, your message necessarily gets degraded. This is relevant to scaling AI companies, while ensuring that your overall process is capable of tracking all the nuances of how and why AI could fail.

[AI Risk2](https://www.lesswrong.com/w/ai-risk)[High Reliability Organizations2](https://www.lesswrong.com/w/high-reliability-organizations)[Organizational Culture & Design2](https://www.lesswrong.com/w/organizational-culture-and-design)[AI1](https://www.lesswrong.com/w/ai)[

Curated

](https://www.lesswrong.com/recommendations)\+ Add Wikitag