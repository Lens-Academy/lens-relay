New, formal definition of agency gives clear principles for causal modelling of AI agents and the incentives they face

We want to build safe, aligned artificial general intelligence (AGI) systems that pursue the intended goals of its designers. [Causal influence diagrams](https://deepmindsafetyresearch.medium.com/progress-on-causal-influence-diagrams-a7a32180b0d1#b09d) (CIDs) are a way to model decision-making situations that allow us to reason about [agent incentives](https://ojs.aaai.org/index.php/AAAI/article/view/17368). For example, here is a CID for a 1-step Markov decision process – a typical framework for decision-making problems.

![](https://lh3.googleusercontent.com/Bp0bDSeGT9IbcFp2f0pBCGAz4Ci3kKtBb-sUhXd7bEYrrzXlGISRWT5oKatw3tOEH8rmXy5v4-ORMJVJWqvc55saD6_NJVDe0Jap7R4w=w1440-rw-lo)

S1 represents the initial state, A1 represents the agent’s decision (square), S2 the next state. R2 is the agent’s reward/utility (diamond). Solid links specify causal influence. Dashed edges specify information links – what the agent knows when making its decision.

By relating training setups to the incentives that shape agent behaviour, CIDs help illuminate potential risks before training an agent and can inspire better agent designs. But how do we know when a CID is an accurate model of a training setup?

Our new paper, [Discovering Agents](https://arxiv.org/abs/2208.08345), introduces new ways of tackling these issues, including:

- The first formal causal definition of agents: **Agents are systems that would adapt their policy if their actions influenced the world in a different way**
- An algorithm for discovering agents from empirical data
- A translation between causal models and CIDs
- Resolving earlier confusions from incorrect causal modelling of agents

Combined, these results provide an extra layer of assurance that a modelling mistake hasn’t been made, which means that CIDs can be used to analyse an agent’s incentives and safety properties with greater confidence.

## Example: modelling a mouse as an agent

To help illustrate our method, consider the following example consisting of a world containing three squares, with a mouse starting in the middle square choosing to go left or right, getting to its next position and then potentially getting some cheese. The floor is icy, so the mouse might slip. Sometimes the cheese is on the right, but sometimes on the left.

![](https://lh3.googleusercontent.com/ES_lvqShn85Aht1wLYaUSRqrtWEP5RJ02JuWffqz7ch12sdibieRtltYSFb9CNlecjoraalcq6CTzj9qA18vMHAZb7kki_pbJ5oqh4NCJ_c=w1440-rw-lo)
*The mouse and the cheese environment.*

This can be represented by the following CID:

![](https://lh3.googleusercontent.com/zdm7jUIZGWkVhE3VCeiJH58vK4yQbH3IySQ0HRO-R3vWBvtdFnTgIKo7iWfOwFd2QzIKems3qL5Ro5Wu13LM1A4NzU1pHUnJ8KrIYvmCVUc=w1440-rw-lo)
*CID for the mouse. D represents the decision of left/right. X is the mouse’s new position after taking the action left/right (it might slip, ending up on the other side by accident). U represents whether the mouse gets cheese or not.*

The intuition that the mouse would choose a different behaviour for different environment settings (iciness, cheese distribution) can be captured by a [mechanised causal graph](https://drive.google.com/file/d/1_OBLw9u29FrqROsLfhO6rIaWGK4xJ3il/view), which for each (object-level) variable, also includes a mechanism variable that governs how the variable depends on its parents. Crucially, we allow for links between mechanism variables.

This graph contains additional mechanism nodes in black, representing the mouse's policy and the iciness and cheese distribution.

Edges between mechanisms represent direct causal influence. The blue edges are special terminal edges – roughly, mechanism edges A~ → B~ that would still be there, even if the object-level variable A was altered so that it had no outgoing edges.

In the example above, since U has no children, its mechanism edge must be terminal. But the mechanism edge X~ → D~ is not terminal, because if we cut X off from its child U, then the mouse will no longer adapt its decision (because its position won’t affect whether it gets the cheese).

## Causal discovery of agents

Causal discovery infers a causal graph from experiments involving interventions. In particular, one can discover an arrow from a variable A to a variable B by experimentally intervening on A and checking if B responds, even if all other variables are held fixed.

Our first algorithm uses this technique to discover the mechanised causal graph:

![](https://lh3.googleusercontent.com/spGFwsxZBHQR8Nc48QH6vjsQ0alu1jx_XuaGjOCtwDv_zyqp0kCcWlW3OkCavYALSH9gaXRRtpjTo4qj-xdqNElRcypVWimB7qKXKUSC=w1440-rw-lo)
*Algorithm 1 takes as input interventional data from the system (mouse and cheese environment) and uses causal discovery to output a mechanised causal graph. See paper for details.*

Our second algorithm transforms this mechanised causal graph to a game graph:

![](https://lh3.googleusercontent.com/YBcntAzyoRvf_aUhamHaa0SKSbh8kk8DgcHNB9YAecXokj9kMJc1sb420OVTd6PWRcaqSiZEk_l9BU7n9fYy7Ys6TCDR392_iDkcgJc_UQ=w1440-rw-lo)
*Algorithm 2 takes as input a mechanised causal graph and maps it to a game graph. An ingoing terminal edge indicates a decision, an outgoing one indicates a utility.*

Taken together, Algorithm 1 followed by Algorithm 2 allows us to discover agents from causal experiments, representing them using CIDs.

Our third algorithm transforms the game graph into a mechanised causal graph, allowing us to translate between the game and mechanised causal graph representations under some additional assumptions:

![](https://lh3.googleusercontent.com/R5Cu1JTJ6hPO5_wdHTAkxDpy-I7ncwNNm5XX6bDOqCpAaRzBlHZd5Nr-L9i-rDWNZ3hNM-u9OMXjr96Ya-6bJCwYuHdqQq3EyXj5VRxa=w1440-rw-lo)
*Algorithm 3 takes as input a game graph and maps it to a mechanised causal graph. A decision indicates an ingoing terminal edge, a utility indicates an outgoing terminal edge.*

## Better safety tools to model AI agents

We proposed the first formal causal definition of agents. Grounded in causal discovery, our key insight is that agents are systems that adapt their behaviour in response to changes in how their actions influence the world. Indeed, our Algorithms 1 and 2 describe a precise experimental process that can help assess whether a system contains an agent.

Interest in causal modelling of AI systems is rapidly growing, and our research grounds this modelling in causal discovery experiments. Our paper demonstrates the potential of our approach by improving the safety analysis of several example AI systems and shows that causality is a useful framework for discovering whether there is an agent in a system – a key concern for assessing risks from AGI.

Excited to learn more? Check out our [paper](https://arxiv.org/abs/2208.08345). Feedback and comments are most welcome.