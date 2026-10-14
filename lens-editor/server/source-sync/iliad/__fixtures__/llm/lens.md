\## 6. Pareto optimality under KL loss

In Section 6 we establish that the Bayesian mixture $$\xi$$ is *uniquely Pareto-optimal* under KL loss: no other predictor can do at least as well as $$\xi$$ on every environment $$\nu \in {\mathcal{M}}$$ without coinciding with $$\xi$$.

:::callout {title="Definition" tone="blue"}

**Definition 6.1 (Pareto domination).** A predictor $$\rho$$ **weakly Pareto-dominates** $$\xi$$ with respect to loss $$\mathcal{F}$$ and class $$\mathcal{M}$$ if $$\mathcal{F}(\nu, \rho) \leq \mathcal{F}(\nu, \xi)$$ for every $$\nu \in {\mathcal{M}}$$.

:::

::::callout {title="Exercise" tone="amber"}
**Exercise 6.1 (KL Pythagorean identity) [10].** For *any* predictor $$\rho$$ with $$\rho(x_{1:n}) > 0$$, show that

$$
D_{n}(\xi \parallel \rho) + \sum_{\nu \in {\mathcal{M}}}w_{\nu} \, D_{n}(\nu \parallel \xi) = \sum_{\nu \in {\mathcal{M}}}w_{\nu} \, D_{n}(\nu \parallel \rho).
$$

:::callout {title="Hint" tone="neutral" collapse="closed"}

Take the difference between the two summation terms.

:::
::::

:::callout {title="Solution" tone="neutral" collapse="closed"}

Take the difference of the two sums. Inside each $$D_{n}$$ the $$\nu \ln \nu$$ pieces cancel. The factor $$\ln(\xi/\rho)$$ does not depend on $$\nu$$, so we swap the order of summation and use $$\sum_{\nu} w_{\nu} \nu = \xi$$. Rearranging gives the claimed identity.

:::

::::callout {title="Exercise" tone="amber"}
**Exercise 6.2 (KL Pareto-optimality) [05].** Show that $$\xi$$ is Pareto-optimal under $$D_{n}(\nu \parallel \rho)$$ in the sense of Definition 6.1.
::::
