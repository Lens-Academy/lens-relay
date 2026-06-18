**Follow-up to:**[AI Alignment: Why It’s Hard, and Where to Start](https://intelligence.org/2016/12/28/ai-alignment-why-its-hard-and-where-to-start/)

---

(***amber**, a philanthropist interested in a more reliable Internet, and **coral**, a computer security professional, are at a conference hotel together discussing what Coral insists is a difficult and important issue: the difficulty of building “secure” software.*)

amber: So, Coral, I understand that you believe it is very important, when creating software, to make that software be what you call “secure”.

coral: Especially if it's connected to the Internet, or if it controls money or other valuables. But yes, that's right.

amber: I find it hard to believe that this needs to be a separate topic in computer science. In general, programmers need to figure out how to make computers do what they want. The people building operating systems surely won't want them to give access to unauthorized users, just like they won't want those computers to crash. Why is one problem so much more difficult than the other?

coral: That's a deep question, but to give a partial deep answer: When you expose a device to the Internet, you're potentially exposing it to intelligent adversaries who can find special, weird interactions with the system that make the pieces behave in weird ways that the programmers did not think of. When you’re dealing with that kind of problem, you’ll use a different set of methods and tools.

amber: Any system that crashes is behaving in a way the programmer didn't expect, and programmers already need to stop that from happening. How is this case different?

coral: Okay, so... imagine that your system is going to take in one kilobyte of input per session. (Although that itself is the sort of assumption we'd question and ask what happens if it gets a megabyte of input instead—but never mind.) If the input is one kilobyte, then there are 2<sup>8,000</sup> possible inputs, or about 10<sup>2,400</sup> or so. Again, for the sake of extending the simple visualization, imagine that a computer gets a billion inputs per second. Suppose that only a googol, 10<sup>100</sup>, out of the 10<sup>2,400</sup> possible inputs, cause the system to behave a certain way the original designer didn't intend.

If the system is getting inputs in a way that's uncorrelated with whether the input is a misbehaving one, it won't hit on a misbehaving state before the end of the universe. If there's an intelligent adversary who understands the system, on the other hand, they may be able to find one of the very rare inputs that makes the system misbehave. So a piece of the system that would literally never in a million years misbehave on random inputs, may break when an intelligent adversary tries deliberately to break it.

amber: So you're saying that it's more difficult because the programmer is pitting their wits against an adversary who may be more intelligent than themselves.

coral: That's an almost-right way of putting it. What matters isn't so much the “adversary” part as the optimization part. There are systematic, nonrandom forces strongly selecting for particular outcomes, causing pieces of the system to go down weird execution paths and occupy unexpected states. If your system literally has no misbehavior modes at all, it doesn't matter if you have IQ 140 and the enemy has IQ 160—it's not an arm-wrestling contest. It's just very much harder to build a system that doesn't enter weird states when the weird states are being selected-for in a correlated way, rather than happening only by accident. The weirdness-selecting forces can search through parts of the larger state space that you yourself failed to imagine. Beating that does indeed require new skills and a different mode of thinking, what Bruce Schneier called “security mindset”.

amber: Ah, and what is this security mindset?

coral: I can say one or two things about it, but keep in mind we are dealing with a quality of thinking that is not entirely effable. If I could give you a handful of platitudes about security mindset, and that would actually cause you to be able to design secure software, the Internet would look very different from how it presently does. That said, it seems to me that what has been called “security mindset” can be divided into two components, one of which is much less difficult than the other. And this can fool people into overestimating their own safety, because they can get the easier half of security mindset and overlook the other half. The less difficult component, I will call by the term “ordinary paranoia”.

amber: *Ordinary* paranoia?

coral: Lots of programmers have the ability to imagine adversaries trying to threaten them. They imagine how likely it is that the adversaries are able to attack them a particular way, and then they try to block off the adversaries from threatening that way. Imagining attacks, including weird or clever attacks, and parrying them with measures you imagine will stop the attack; that is ordinary paranoia.

amber: Isn't that what security is all about? What do you claim is the other half?

coral: To put it as a platitude, I might say… defending against mistakes in your own assumptions rather than against external adversaries.

amber: Can you give me an example of a difference?

coral: An ordinary paranoid programmer imagines that an adversary might try to read the file containing all the usernames and passwords. They might try to store the file in a special, secure area of the disk or a special subpart of the operating system that's supposed to be harder to read. Conversely, somebody with security mindset thinks, “No matter what kind of special system I put around this file, I'm disturbed by needing to make the assumption that this file can't be read. Maybe the special code I write, because it's used less often, is more likely to contain bugs. Or maybe there's a way to fish data out of the disk that doesn't go through the code I wrote.”

amber: And they imagine more and more ways that the adversary might be able to get at the information, and block those avenues off too! Because they have better imaginations.

coral: Well, we kind of do, but that's not the key difference. What we'll really want to do is come up with a way for the computer to check passwords that doesn't rely on the computer storing the password *at all, anywhere*.

amber: Ah, like encrypting the password file!

coral: No, that just duplicates the problem at one remove. If the computer can decrypt the password file to check it, it's stored the decryption key somewhere, and the attacker may be able to steal that key too.

amber: But then the attacker has to steal two things instead of one; doesn't that make the system more secure? Especially if you write two different sections of special filesystem code for hiding the encryption key and hiding the encrypted password file?

coral: That's exactly what I mean by distinguishing “ordinary paranoia” that doesn't capture the full security mindset. So long as the system is capable of reconstructing the password, we'll always worry that the adversary might be able to trick the system into doing just that. What somebody with security mindset will recognize as a deeper solution is to store a one-way hash of the password, rather than storing the plaintext password. Then even if the attacker reads off the password file, they still can't give what the system will recognize as a password.

amber: Ah, that's quite clever! But I don't see what's so qualitatively different between that measure, and my measure for hiding the key and the encrypted password file separately. I agree that your measure is more clever and elegant, but of course you'll know better standard solutions than I do, since you work in this area professionally. I don't see the qualitative line dividing your solution from my solution.

coral: Um, it's hard to say this without offending some people, but... it's possible that even after I try to explain the difference, which I'm about to do, you won't get it. Like I said, if I could give you some handy platitudes and transform you into somebody capable of doing truly good work in computer security, the Internet would look very different from its present form. I can try to describe one aspect of the difference, but that may put me in the position of a mathematician trying to explain what looks more promising about one proof avenue than another; you can listen to everything they say and nod along and still not be transformed into a mathematician. So I *am* going to try to explain the difference, but again, I don’t know of any simple instruction manuals for becoming Bruce Schneier.

amber: I confess to feeling slightly skeptical at this supposedly ineffable ability that some people possess and others don't—

coral: There are things like that in many professions. Some people pick up programming at age five by glancing through a page of BASIC programs written for a TRS-80, and some people struggle really hard to grasp basic Python at age twenty-five. That's not because there's some mysterious truth the five-year-old knows that you can verbally transmit to the twenty-five-year-old.

And, yes, the five-year-old will become far better with practice; it's not like we're talking about untrainable genius. And there may be platitudes you can tell the 25-year-old that will help them struggle a little less. But sometimes a profession requires thinking in an unusual way and some people's minds more easily turn sideways in that particular dimension.

amber: Fine, go on.

coral: Okay, so... you thought of putting the encrypted password file in one special place in the filesystem, and the key in another special place. Why not encrypt the key too, write a third special section of code, and store the key to the encrypted key there? Wouldn't that make the system even more secure? How about seven keys hidden in different places, wouldn't that be extremely secure? Practically unbreakable, even?

amber: Well, that version of the idea does feel a little silly. If you're trying to secure a door, a lock that takes two keys might be more secure than a lock that only needs one key, but seven keys doesn't feel like it makes the door that much more secure than two.

coral: Why not?

amber: It just seems silly. You'd probably have a better way of saying it than I would.

coral: Well, a fancy way of describing the silliness is that the chance of obtaining the seventh key is not conditionally independent of the chance of obtaining the first two keys. If I can read the encrypted password file, and read your encrypted encryption key, then I've probably come up with something that just bypasses your filesystem and reads directly from the disk. And the more complicated you make your filesystem, the more likely it is that I can find a weird system state that will let me do just that. Maybe the special section of filesystem code you wrote to hide your fourth key is the one with the bug that lets me read the disk directly.

amber: So the difference is that the person with a *true* security mindset found a defense that makes the system simpler rather than more complicated.

coral: Again, that's almost right. By hashing the passwords, the security professional has made their *reasoning* about the system less complicated. They've eliminated the need for an assumption that might be put under a lot of pressure. If you put the key in one special place and the encrypted password file in another special place, the system as a whole is still able to decrypt the user's password. An adversary probing the state space might be able to trigger that password-decrypting state because the system is designed to do that on at least some occasions. By hashing the password file we eliminate that whole internal debate from the reasoning on which the system's security rests.

amber: But even after you've come up with that clever trick, something could still go wrong. You're still not absolutely secure. What if somebody uses “password” as their password?

coral: Or what if somebody comes up a way to read off the password after the user has entered it and while it's still stored in RAM, because something got access to RAM? The point of eliminating the extra assumption from the reasoning about the system's security is not that we are then absolutely secure and safe and can relax. Somebody with security mindset is *never* going to be that relaxed about the edifice of reasoning saying the system is secure.

For that matter, while there are some normal programmers doing normal programming who might put in a bunch of debugging effort and then feel satisfied, like they'd done all they could reasonably do, programmers with decent levels of ordinary paranoia about ordinary programs will go on chewing ideas in the shower and coming up with more function tests for the system to pass. So the distinction between security mindset and ordinary paranoia isn't that ordinary paranoids will relax. It's that... again to put it as a platitude, the ordinary paranoid is running around putting out fires in the form of ways they imagine an adversary might attack, and somebody with security mindset is defending against something closer to “what if an element of this reasoning is mistaken”. Instead of trying really hard to ensure nobody can read a disk, we are going to build a system that's secure even if somebody does read the disk, and *that* is our first line of defense. And then we are also going to build a filesystem that doesn't let adversaries read the password file, as a *second* line of defense in case our one-way hash is secretly broken, and because there's no positive need to let adversaries read the disk so why let them. And then we're going to salt the hash in case somebody snuck a low-entropy password through our system and the adversary manages to read the password anyway.

amber: So rather than trying to outwit adversaries, somebody with true security mindset tries to make fewer assumptions.

coral: Well, we think in terms of adversaries too! Adversarial reasoning is easier to teach than security mindset, but it's still (a) mandatory and (b) hard to teach in an absolute sense. A lot of people can't master it, which is why a description of “security mindset” often opens with a story about somebody failing at adversarial reasoning and somebody else launching a clever attack to penetrate their defense.

You need to master two ways of thinking, and there are a lot of people going around who have the first way of thinking but not the second. One way I'd describe the deeper skill is seeing a system's security as resting on a story about why that system is safe. We want that safety-story to be as solid as possible. One of the implications is resting the story on as few assumptions as possible; as the saying goes, the only gear that never fails is one that has been designed out of the machine.

amber: But can't you also get better security by adding more lines of defense? Wouldn't that be more complexity in the story, and also better security?

coral: There's also something to be said for preferring disjunctive reasoning over conjunctive reasoning in the safety-story. But it's important to realize that you do want a primary line of defense that is supposed to just work and be unassailable, not a series of weaker fences that you think might maybe work. Somebody who doesn't understand cryptography might devise twenty clever-seeming amateur codes and apply them all in sequence, thinking that, even if one of the codes turns out to be breakable, surely they won't *all* be breakable. The NSA will assign that mighty edifice of amateur encryption to an intern, and the intern will crack it in an afternoon. There's something to be said for redundancy, and having fallbacks in case the unassailable wall falls; it can be wise to have additional lines of defense, so long as the added complexity does not make the larger system harder to understand or increase its vulnerable surfaces. But at the core you need a simple, solid story about why the system is secure, and a good security thinker will be trying to eliminate whole assumptions from that story and strengthening its core pillars, not only scurrying around parrying expected attacks and putting out risk-fires.

That said, it's better to use two true assumptions than one false assumption, so simplicity isn't everything.

amber: I wonder if that way of thinking has applications beyond computer security?

coral: I'd rather think so, as the proverb about gears suggests.

For example, stepping out of character for a moment, the author of this dialogue has sometimes been known to discuss [the alignment problem for Artificial General Intelligence](https://www.lesswrong.com/w/ai_alignment). He was talking at one point about trying to measure rates of improvement inside a growing AI system, so that it would not do too much thinking with humans out of the loop if a breakthrough occurred while the system was running overnight. The person he was talking to replied that, to him, it seemed unlikely that an AGI would gain in power that fast. To which the author replied, more or less:

> It shouldn't be your job to guess how fast the AGI might improve! If you write a system that will hurt you *if* a certain speed of self-improvement turns out to be possible, then you've written the wrong code. The code should just never hurt you regardless of the true value of that background parameter.
> 
> A better way to set up the AGI would be to measure how much improvement is taking place, and if more than *X* improvement takes place, suspend the system until a programmer validates the progress that's already occurred. That way even if the improvement takes place over the course of a millisecond, you're still fine, so long as the system works as intended. Maybe the system doesn't work as intended because of some other mistake, but that's a better problem to worry about than a system that hurts you *even if* it works as intended.
> 
> Similarly, you want to design the system so that if it discovers amazing new capabilities, it waits for an operator to validate use of those capabilities—not rely on the operator to watch what's happening and press a suspend button. You shouldn't rely on the speed of discovery or the speed of disaster being less than the operator's reaction time. There's no *need* to bake in an assumption like that if you can find a design that's safe regardless. For example, by operating on a paradigm of allowing operator-whitelisted methods rather than avoiding operator-blacklisted methods; you require the operator to say “Yes” before proceeding, rather than assuming they're present and attentive and can say “No” fast enough.

amber: Well, okay, but if we're guarding against an AI system discovering cosmic powers in a millisecond, that does seem to me like an unreasonable thing to worry about. I guess that marks me as a merely ordinary paranoid.

coral: Indeed, one of the hallmarks of security professionals is that they spend a lot of time worrying about edge cases that would fail to alarm an ordinary paranoid because the edge case doesn't sound like something an adversary is likely to do. Here's an example [from the Freedom to Tinker blog](https://freedom-to-tinker.com/2008/03/26/security-mindset-and-harmless-failures/):

> This interest in “harmless failures” – cases where an adversary can cause an anomalous but not directly harmful outcome – is another hallmark of the security mindset. Not all “harmless failures” lead to big trouble, but it’s surprising how often a clever adversary can pile up a stack of seemingly harmless failures into a dangerous tower of trouble. Harmless failures are bad hygiene. We try to stamp them out when we can...
> 
> To see why, consider the donotreply.com email story that hit the press recently. When companies send out commercial email (e.g., an airline notifying a passenger of a flight delay) and they don’t want the recipient to reply to the email, they often put in a bogus From address like donotreply@donotreply.com. A clever guy registered the domain donotreply.com, thereby receiving all email addressed to donotreply.com. This included “bounce” replies to misaddressed emails, some of which contained copies of the original email, with information such as bank account statements, site information about military bases in Iraq, and so on...
> 
> The people who put donotreply.com email addresses into their outgoing email must have known that they didn’t control the donotreply.com domain, so they must have thought of any reply messages directed there as harmless failures. Having gotten that far, there are two ways to avoid trouble. The first way is to think carefully about the traffic that might go to donotreply.com, and realize that some of it is actually dangerous. The second way is to think, “This looks like a harmless failure, but we should avoid it anyway. No good can come of this.” The first way protects you if you’re clever; the second way always protects you.

"The first way protects you if you're clever; the second way always protects you." That's very much the other half of the security mindset. It's what this essay's author was doing by talking about AGI alignment that runs on whitelisting rather than blacklisting: you shouldn't assume you’ll be clever about how fast the AGI system could discover capabilities, you should have a system that doesn't use not-yet-whitelisted capabilities even if they are discovered very suddenly.

If your AGI would hurt you if it gained total cosmic powers in one millisecond, that means you built a cognitive process that is in some sense trying to hurt you and failing only due to what you think is a lack of capability. This is *very bad* and you should be designing some other AGI system instead. AGI systems should never be running a search that will hurt you if the search comes up non-empty. You should not be trying to fix that by making sure the search comes up empty thanks to your clever shallow defenses closing off all the AGI's clever avenues for hurting you. You should fix that by making sure no search like that ever runs. It's a silly thing to do with computing power, and you should do something else with computing power instead.

Going back to ordinary computer security, if you try building a lock with seven keys hidden in different places, you are in some dimension pitting your cleverness against an adversary trying to read the keys. The person with security mindset doesn't want to rely on having to win the cleverness contest. An ordinary paranoid, somebody who can master the kind of default paranoia that lots of intelligent programmers have, will look at the Reply-To field saying donotreply@donotreply.com and think about the possibility of an adversary registering the donotreply.com domain. Somebody with security mindset thinks in assumptions rather than adversaries. “Well, I'm assuming that this reply email goes nowhere,” they'll think, “but maybe I should design the system so that I don't need to fret about whether that assumption is true.”

amber: Because as the truly great paranoid knows, what seems like a ridiculously improbable way for the adversary to attack sometimes turns out to not be so ridiculous after all.

coral: Again, that's a not-exactly-right way of putting it. When I don't set up an email to originate from donotreply@donotreply.com, it's not just because I've appreciated that an adversary registering donotreply.com is more probable than the novice imagines. For all I know, when a bounce email is sent to nowhere, there's all kinds of things that might happen! Maybe the way a bounced email works is that the email gets routed around to weird places looking for that address. I don't know, and I don't want to have to study it. Instead I'll ask: Can I make it so that a bounced email doesn't generate a reply? Can I make it so that a bounced email doesn't contain the text of the original message? Maybe I can query the email server to make sure it still has a user by that name before I try sending the message?—though there may still be “vacation” autoresponses that mean I'd better control the replied-to address myself. If it would be very bad for somebody unauthorized to read this, maybe I shouldn't be sending it in plaintext by email.

amber: So the person with true security mindset understands that where there's one problem, demonstrated by what seems like a very unlikely thought experiment, there's likely to be more realistic problems that an adversary can in fact exploit. What I think of as weird improbable failure scenarios are canaries in the coal mine, that would warn a truly paranoid person of bigger problems on the way.

coral: Again that's not exactly right. The person with ordinary paranoia hears about donotreply@donotreply.com and may think something like, “Oh, well, it's not very likely that an attacker will actually try to register that domain, I have more urgent issues to worry about,” because in that mode of thinking, they're running around putting out things that might be fires, and they have to prioritize the things that are most likely to be fires.

If you demonstrate a weird edge-case thought experiment to somebody with security mindset, they don't see something that's more likely to be a fire. They think, “Oh no, my belief that those bounce emails go nowhere was FALSE!” The OpenBSD project to build a secure operating system has also, in passing, built an extremely robust operating system, because from their perspective any bug that potentially crashes the system is considered a critical security hole. An ordinary paranoid sees an input that crashes the system and thinks, “A crash isn't as bad as somebody stealing my data. Until you demonstrate to me that this bug can be used by the adversary to steal data, it's not *extremely* critical.” Somebody with security mindset thinks, “Nothing inside this subsystem is supposed to behave in a way that crashes the OS. Some section of code is behaving in a way that does not work like my model of that code. Who knows what it might do? The system isn't supposed to crash, so by making it crash, you have demonstrated that my beliefs about how this system works are false.”

amber: I'll be honest: It *has* sometimes struck me that people who call themselves security professionals seem overly concerned with what, to me, seem like very improbable scenarios. Like somebody forgetting to check the end of a buffer and an adversary throwing in a huge string of characters that overwrite the end of the stack with a return address that jumps to a section of code somewhere else in the system that does something the adversary wants. How likely is that *really* to be a problem? I suspect that in the real world, what's more likely is somebody making their password “password”. Shouldn't you be mainly guarding against that instead?

coral: You have to do both. This game is short on consolation prizes. If you want your system to resist attack by major governments, you need it to actually be pretty darned secure, gosh darn it. The fact that some users may try to make their password be “password” does not change the fact that you also have to protect against buffer overflows.

amber: But even when somebody with security mindset designs an operating system, it often still ends up with successful attacks against it, right? So if this deeper paranoia doesn't eliminate all chance of bugs, is it really worth the extra effort?

coral: If you don't have somebody who thinks this way in charge of building your operating system, it has *no* chance of not failing immediately. People with security mindset sometimes fail to build secure systems. People without security mindset *always* fail at security if the system is at all complex. What this way of thinking buys you is a *chance* that your system takes longer than 24 hours to break.

amber: That sounds a little extreme.

coral: History shows that reality has not cared what you consider “extreme” in this regard, and that is why your Wi-Fi-enabled lightbulb is part of a Russian botnet.

amber: Look, I understand that you want to get all the fiddly tiny bits of the system exactly right. I like tidy neat things too. But let's be reasonable; we can't always get everything we want in life.

coral: You think you're negotiating with me, but you're really negotiating with Murphy's Law. I'm afraid that Mr. Murphy has historically been quite unreasonable in his demands, and rather unforgiving of those who refuse to meet them. I'm not advocating a policy to you, just telling you what happens if you don't follow that policy. Maybe you think it's not particularly bad if your lightbulb is doing denial-of-service attacks on a mattress store in Estonia. But if you do want a system to be secure, you need to do certain things, and that part is more of a law of nature than a negotiable demand.

amber: Non-negotiable, eh? I bet you'd change your tune if somebody offered you twenty thousand dollars. But anyway, one thing I'm surprised you're not mentioning more is the part where people with security mindset always submit their idea to peer scrutiny and then accept what other people vote about it. I do like the sound of that; it sounds very communitarian and modest.

coral: I'd say that's part of the ordinary paranoia that lots of programmers have. The point of submitting ideas to others' scrutiny isn't that hard to understand, though certainly there are plenty of people who don't even do that. If I had any original remarks to contribute to that well-worn topic in computer security, I'd remark that it's framed as advice to wise paranoids, but of course the people who need it even more are the happy innocents.

amber: Happy innocents?

coral: People who lack even ordinary paranoia. Happy innocents tend to envision ways that their system works, but not ask *at all* how their system might fail, until somebody prompts them into that, and even then they can't do it. Or at least that's been my experience, and that of many others in the profession.

There's a certain incredibly terrible cryptographic system, the equivalent of the Fool's Mate in chess, which is sometimes converged on by the most total sort of amateur, namely Fast XOR. That's picking a password, repeating the password, and XORing the data with the repeated password string. The person who invents this system may not be able to take the perspective of an adversary at all. *He* wants his marvelous cipher to be unbreakable, and he is not able to truly enter the frame of mind of somebody who wants his cipher to be breakable. If you ask him, “Please, *try* to imagine what could possibly go wrong,” he may say, “Well, if the password is lost, the data will be forever unrecoverable because my encryption algorithm is too strong; I guess that's something that could go wrong.” Or, “Maybe somebody sabotages my code,” or, “If you really insist that I invent far-fetched scenarios, maybe the computer spontaneously decides to disobey my programming.” Of course any competent ordinary paranoid asks the most skilled people they can find to look at a bright idea and try to shoot it down, because other minds may come in at a different angle or know other standard techniques. But the other reason why we say “Don't roll your own crypto!” and “Have a security expert look at your bright idea!” is in hopes of reaching the many people who can't *at all* invert the polarity of their goals—they don't think that way spontaneously, and if you try to force them to do it, their thoughts go in unproductive directions.

amber: Like... the same way many people on the Right/Left seem utterly incapable of stepping outside their own treasured perspectives to pass the [Ideological Turing Test](http://econlog.econlib.org/archives/2011/06/the_ideological.html) of the Left/Right.

coral: I don't know if it's exactly the same mental gear or capability, but there's a definite similarity. Somebody who lacks ordinary paranoia can't take on the viewpoint of somebody who wants Fast XOR to be breakable, and pass that adversary's Ideological Turing Test for attempts to break Fast XOR.

amber: Can't, or won't? You seem to be talking like these are innate, untrainable abilities.

coral: Well, at the least, there will be different levels of talent, as usual in a profession. And also as usual, talent vastly benefits from training and practice. But yes, it has sometimes seemed to me that there is a kind of qualitative step or gear here, where some people can shift perspective to imagine an adversary that truly wants to break their code... or a reality that isn't cheering for their plan to work, or aliens who evolved different emotions, or an AI that doesn't *want* to conclude its reasoning with “And therefore the humans should live happily ever after”, or a fictional character who believes in Sith ideology and yet [doesn't believe they're the bad guy](http://yudkowsky.tumblr.com/writing/realistic-viewpoints).

It does sometimes seem to me like some people simply can't shift perspective in that way. Maybe it's not that they truly lack the wiring, but that there's an instinctive political off-switch for the ability. Maybe they're scared to let go of their mental anchors. But from the outside it looks like the same result: some people do it, some people don't. Some people spontaneously invert the polarity of their internal goals and spontaneously ask how their cipher might be broken and come up with productive angles of attack. Other people wait until prompted to look for flaws in their cipher, or they demand that you argue with them and wait for you to come up with an argument that satisfies them. If you ask them to predict themselves what you might suggest as a flaw, they say weird things that don't begin to pass your Ideological Turing Test.

amber: You do seem to like your qualitative distinctions. Are there better or worse ordinary paranoids? Like, is there a spectrum in the space between “happy innocent” and “true deep security mindset”?

coral: One obvious quantitative talent level within ordinary paranoia would be in how far you can twist your perspective to look sideways at things—the creativity and workability of the attacks you invent. Like these [examples](https://www.schneier.com/blog/archives/2008/03/the_security_mi_1.html) Bruce Schneier gave:

> Uncle Milton Industries has been selling ant farms to children since 1956. Some years ago, I remember opening one up with a friend. There were no actual ants included in the box. Instead, there was a card that you filled in with your address, and the company would mail you some ants. My friend expressed surprise that you could get ants sent to you in the mail.
> 
> I replied: “What's really interesting is that these people will send a tube of live ants to anyone you tell them to.”
> 
> Security requires a particular mindset. Security professionals—at least the good ones—see the world differently. They can't walk into a store without noticing how they might shoplift. They can't use a computer without wondering about the security vulnerabilities. They can't vote without trying to figure out how to vote twice. They just can't help it.
> 
> SmartWater is a liquid with a unique identifier linked to a particular owner. “The idea is for me to paint this stuff on my valuables as proof of ownership,” I wrote when I first learned about the idea. “I think a better idea would be for me to paint it on your valuables, and then call the police.”
> 
> Really, we can't help it.
> 
> This kind of thinking is not natural for most people. It's not natural for engineers. Good engineering involves thinking about how things can be made to work; the security mindset involves thinking about how things can be made to fail...
> 
> I've often speculated about how much of this is innate, and how much is teachable. In general, I think it's a particular way of looking at the world, and that it's far easier to teach someone domain expertise—cryptography or software security or safecracking or document forgery—than it is to teach someone a security mindset.

To be clear, the distinction between “just ordinary paranoia” and “all of security mindset” is my own; I think it's worth dividing the spectrum above the happy innocents into two levels rather than one, and say, “This business of looking at the world from weird angles is only half of what you need to learn, and it's the easier half.”

amber: Maybe Bruce Schneier himself doesn't grasp what you mean when you say “security mindset”, and you've simply stolen his term to refer to a whole new idea of your own!

coral: No, the thing with not wanting to have to reason about whether somebody might someday register “donotreply.com” and just fixing it regardless—a methodology that doesn't trust you to be clever about which problems will blow up—that's definitely part of what existing security professionals mean by “security mindset”, and it's definitely part of the second and deeper half. The only unconventional thing in my presentation is that I'm factoring out an intermediate skill of “ordinary paranoia”, where you try to parry an imagined attack by encrypting your password file and hiding the encryption key in a separate section of filesystem code. Coming up with the idea of hashing the password file is, I suspect, a qualitatively distinct skill, invoking a world whose dimensions are your own reasoning processes and not just object-level systems and attackers. Though it's not polite to say, and the usual suspects will interpret it as a status grab, my experience with other reflectivity-laden skills suggests this may mean that many people, possibly including you, will prove unable to think in this way.

amber: I indeed find that terribly impolite.

coral: It may indeed be impolite; I don't deny that. Whether it's untrue is a different question. The reason I say it is because, as much as I want ordinary paranoids to *try* to reach up to a deeper level of paranoia, I want them to be aware that it might not prove to be their thing, in which case they should get help and then listen to that help. They shouldn't assume that because they can notice the chance to have ants mailed to people, they can also pick up on the awfulness of donotreply@donotreply.com.

amber: Maybe you could call that “deep security” to distinguish it from what Bruce Schneier and other security professionals call “security mindset”.

coral: “Security mindset” equals “ordinary paranoia” plus “deep security”? I'm not sure that's very good terminology, but I won't mind if you use the term that way.

amber: Suppose I take that at face value. Earlier, you described what might go wrong when a happy innocent tries and fails to be an ordinary paranoid. What happens when an ordinary paranoid tries to do something that requires the deep security skill?

coral: They believe they have wisely identified bad passwords as the real fire in need of putting out, and spend all their time writing more and more clever checks for bad passwords. They are very impressed with how much effort they have put into detecting bad passwords, and how much concern they have shown for system security. They fall prey to the standard cognitive bias whose name I can't remember, where people want to solve a problem using one big effort or a couple of big efforts and then be done and not try anymore, and that's why people don't put up hurricane shutters once they're finished buying bottled water. Pay them to “try harder”, and they'll hide seven encryption keys to the password file in seven different places, or build towers higher and higher in places where a successful adversary is obviously just walking around the tower if they've gotten through at all. What these ideas have in common is that they are in a certain sense “shallow”. They are mentally straightforward as attempted parries against a particular kind of envisioned attack. They give you a satisfying sense of fighting hard against the imagined problem—and then they fail.

amber: Are you saying it's *not* a good idea to check that the user's password isn't “password”?

coral: No, shallow defenses are often good ideas too! But even there, somebody with the higher skill will try to look at things in a more systematic way; they know that there are often deeper ways of looking at the problem to be found, and they'll try to find those deep views. For example, it's extremely important that your password checker does *not* rule out the password “correct horse battery staple” by demanding the password contain at least one uppercase letter, lowercase letter, number, and punctuation mark. What you really want to do is measure password entropy. Not envision a failure mode of somebody guessing “rainbow”, which you will cleverly balk by forcing the user to make their password be “rA1nbow!” instead.

You want the password entry field to have a checkbox that allows showing the typed password in plaintext, because your attempt to parry the imagined failure mode of some evildoer reading over the user's shoulder may get in the way of the user entering a long or high-entropy password. And the user is perfectly capable of typing their password into that convenient text field in the address bar above the web page, so they can copy and paste it—thereby sending your password to whoever tries to do smart lookups on the address bar. If you're really that worried about some evildoer reading over somebody's shoulder, maybe you should be sending a confirmation text to their phone, rather than forcing the user to enter their password into a nearby text field that they can actually read. Obscuring one text field, with no off-switch for the obscuration, to guard against this one bad thing that you imagined happening, while managing to step on your own feet in other ways and not even really guard against the bad thing; that's the peril of shallow defenses.

An archetypal character for “ordinary paranoid who thinks he's trying really hard but is actually just piling on a lot of shallow precautions” is Mad-Eye Moody from the *Harry Potter* series, who has a whole room full of Dark Detectors, and who also ends up locked in the bottom of somebody's trunk. It seems Mad-Eye Moody was too busy buying one more Dark Detector for his existing room full of Dark Detectors, and he didn't invent precautions deep enough and general enough to cover the unforeseen attack vector “somebody tries to replace me using Polyjuice”.

And the solution isn't to add on a special anti-Polyjuice potion. I mean, if you happen to have one, great, but that's not where most of your trust in the system should be coming from. The first lines of defense should have a sense about them of depth, of generality. Hashing password files, rather than hiding keys; thinking of how to measure password entropy, rather than requiring at least one uppercase character.

amber: Again this seems to me more like a quantitative difference in the cleverness of clever ideas, rather than two different modes of thinking.

coral: Real-world categories are often fuzzy, but to me these seem like the product of two different kinds of thinking. My guess is that the person who popularized demanding a mixture of letters, cases, and numbers was reasoning in a different way than the person who thought of measuring password entropy. But whether you call the distinction qualitative or quantitative, the distinction remains. Deep and general ideas—the kind that actually simplify and strengthen the edifice of reasoning supporting the system's safety—are invented more rarely and by rarer people. To build a system that can resist or even slow down an attack by multiple adversaries, some of whom may be smarter or more experienced than ourselves, requires a level of professionally specialized thinking that isn't reasonable to expect from every programmer—not even those who can shift their minds to take on the perspective of a single equally-smart adversary. What you should ask from an ordinary paranoid is that they appreciate that deeper ideas exist, and that they try to learn the standard deeper ideas that are already known; that they know their own skill is not the upper limit of what's possible, and that they ask a professional to come in and check their reasoning. And then actually listen.

amber: But if it's possible for people to think they have higher skills and be mistaken, how do you know that *you* are one of these rare people who *truly* has a deep security mindset? Might your high opinion of yourself [just be due to the Dunning-Kruger effect](https://www.lesswrong.com/posts/zsG9yKcriht2doRhM/inadequacy-and-modesty)?

coral:... Okay, that reminds me to give another caution.

Yes, there will be some innocents who can't believe that there's a talent called “paranoia” that they lack, who'll come up with weird imitations of paranoia if you ask them to be more worried about flaws in their brilliant encryption ideas. There will also be some people reading this with severe cases of [social anxiety and underconfidence](https://www.lesswrong.com/posts/o28fkhcZsBhhgfGjx/status-regulation-and-anxious-underconfidence). Readers who *are* capable of ordinary paranoia and even security mindset, who might not try to develop these talents, because they are terribly worried that they might just be one of the people who only imagine themselves to have talent. Well, if you think you can feel the distinction between deep security ideas and shallow ones, you should at least try now and then to generate your own thoughts that resonate in you the same way.

amber: But won't that attitude encourage overconfident people to think they can be paranoid when they actually can't be, with the result that they end up too impressed with their own reasoning and ideas?

coral: I strongly suspect that they'll do that regardless. You're not actually promoting some kind of collective good practice that benefits everyone, just by personally agreeing to be modest. The overconfident don't care what you decide. And if you're not just as worried about underestimating yourself as overestimating yourself, if your fears about exceeding your proper place are asymmetric with your fears about lost potential and foregone opportunities, then you're probably dealing with an emotional issue rather than a strict concern with good epistemology.

amber: If somebody does have the talent for deep security, then, how can they train it?

coral: … That's a hell of a good question. Some interesting training methods have been developed for ordinary paranoia, like classes whose students have to figure out how to attack everyday systems outside of a computer-science context. One professor gave a test in which one of the questions was “What are the first 100 digits of pi?”—the point being that you need to find some way to cheat in order to pass the test. You should train that kind of ordinary paranoia first, if you haven't done that already.

amber: And then what? How do you graduate to deep security from ordinary paranoia?

coral: … Try to find more general defenses instead of parrying particular attacks? Appreciate the extent to which you're building ever-taller versions of towers that an adversary might just walk around? Ugh, no, that's too much like ordinary paranoia—especially if you're starting out with just ordinary paranoia. Let me think about this.

...

Okay, I have a screwy piece of advice that's probably not going to work. Write down the safety-story on which your belief in a system's security rests. Then ask yourself whether you actually included all the empirical assumptions. Then ask yourself whether you actually believe those empirical assumptions.

amber: So, like, if I'm building an operating system, I write down, “Safety assumption: The login system works to keep out attackers”—

coral:*No!*

Uh, no, sorry. As usual, it seems that what I think is “advice” has left out all the important parts anyone would need to actually do it.

That's not what I was trying to handwave at by saying “empirical assumption”. You don't want to assume that parts of the system “succeed” or “fail”—that's not language that should appear in what you write down. You want the elements of the story to be strictly factual, not... value-laden, goal-laden? There shouldn't be reasoning that explicitly mentions what you want to have happen or not happen, just language neutrally describing the background facts of the universe. For brainstorming purposes you might write down “Nobody can guess the password of any user with dangerous privileges”, but that's just a proto-statement which needs to be refined into more basic statements.

amber: I don't think I understood.

coral: “Nobody can guess the password” says, “I believe the adversary will fail to guess the password.” Why do you believe that?

amber: I see, so you want me to refine complex assumptions into systems of simpler assumptions. But if you keep asking “why do you believe that” you'll eventually end up back at the Big Bang and the laws of physics. How do I know when to stop?

coral: What you're trying to do is reduce the story past the point where you talk about a goal-laden event, “the adversary fails”, and instead talk about neutral facts underlying that event. For now, just answer me: Why do you believe the adversary fails to guess the password?

amber: Because the password is too hard to guess.

coral: The phrase “too hard” is goal-laden language; it's your own desires for the system that determine what is “too hard”. Without using concepts or language that refer to what you want, what is a neutral, factual description of what makes a password too hard to guess?

amber: The password has high-enough entropy that the attacker can't try enough attempts to guess it.

coral: We're making progress, but again, the term “enough” is goal-laden language. It's your own wants and desires that determine what is “enough”. Can you say something else instead of “enough”?

amber: The password has sufficient entropy that—

coral: I don't mean find a synonym for “enough”. I mean, use different concepts that aren't goal-laden. This will involve changing the meaning of what you write down.

amber: I'm sorry, I guess I'm not good enough at this.

coral: Not yet, anyway. Maybe not ever, but that isn't known, and you shouldn't assume it based on one failure.

Anyway, what I was hoping for was a pair of statements like, “I believe every password has at least 50 bits of entropy” and “I believe no attacker can make more than a trillion tries total at guessing any password”. Where the point of writing “I believe” is to make yourself pause and question whether you actually believe it.

amber: Isn't saying no attacker “can” make a trillion tries itself goal-laden language?

coral: Indeed, that assumption might need to be refined further via why-do-I-believe-that into, “I believe the system rejects password attempts closer than 1 second together, I believe the attacker keeps this up for less than a month, and I believe the attacker launches fewer than 300,000 simultaneous connections.” Where again, the point is that you then look at what you've written and say, “Do I really believe that?” To be clear, sometimes the answer will be “Yes, I sure do believe that!” This isn't a social modesty exercise where you show off your ability to have agonizing doubts and then you go ahead and do the same thing anyway. The point is to find out what you believe, or what you'd need to believe, and check that it's believable.

amber: And this trains a deep security mindset?

coral: … Maaaybe? I'm wildly guessing it might? It may get you to think in terms of stories and reasoning and assumptions alongside passwords and adversaries, and that puts your mind into a space that I think is at least part of the skill.

In point of fact, the real reason the author is listing out this methodology is that he's currently trying to do something similar on the problem of aligning Artificial General Intelligence, and he would like to move past “I believe my AGI won't want to kill anyone” and into a headspace more like writing down statements such as “Although the space of potential weightings for this recurrent neural net does contain weight combinations that would figure out how to kill the programmers, I believe that gradient descent on loss function *L* will only access a result inside subspace *Q* with properties *P*, and I believe a space with properties *P* does not include any weight combinations that figure out how to kill the programmer.”

Though this itself is not really a reduced statement and still has too much goal-laden language in it. A realistic example would take us right out of the main essay here. But the author does hope that practicing this way of thinking can help lead people into building more solid stories about robust systems, if they already have good ordinary paranoia and some fairly mysterious innate talents.

---

To be continued in: **[Security Mindset and the Logistic Success Curve](https://www.lesswrong.com/posts/cpdsMuAHSWhWnKdog/security-mindset-and-the-logistic-success-curve)**

x

Security Mindset and Ordinary Paranoia — LessWrong