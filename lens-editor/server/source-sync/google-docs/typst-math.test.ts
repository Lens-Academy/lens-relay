import { describe, expect, it } from "vitest";
import { typstMathToTex } from "./typst-math";

const tex = (typst: string) => typstMathToTex(typst).tex;

describe("typstMathToTex", () => {
  it.each([
    ["2 times 10^29", "2 \\times 10^{29}"],
    ["s_(t+1)", "s_{t+1}"],
    ["sum_(t=0)^infinity gamma^t r_t", "\\sum_{t=0}^{\\infty} \\gamma^{t} r_{t}"],
    ["R: (S times A) -> RR", "R: (S \\times A) \\to \\mathbb{R}"],
    ['"Effective compute" = "a" times "b"', "\\text{Effective compute} = \\text{a} \\times \\text{b}"],
    ['"50% a_b"', "\\text{50\\% a\\_b}"],
    ["a_t tilde pi_theta(dot.c | s_t)", "a_{t} \\sim \\pi_{\\theta}(\\cdot \\mid s_{t})"],
    ["V^pi(s) = E_pi(R | s_t = s), |x|", "V^{\\pi}(s) = E_{\\pi}(R \\mid s_{t} = s), |x|"],
    ["F_n approx n L_n (w) + lambda log n", "F_{n} \\approx n L_{n} (w) + \\lambda \\log n"],
    ["hat(y) != y", "\\hat{y} \\ne y"],
    ["2pi r", "2\\pi r"],
    // Multi-character operators are read whole, longest first.
    ["a <=> b <-> c |-> d ==> e", "a \\Leftrightarrow b \\leftrightarrow c \\mapsto d \\implies e"],
    // Accents and functions.
    ["dot(x) + a dot b", "\\dot{x} + a \\cdot b"],
    ["vec(1, 2)", "\\begin{pmatrix}1 \\cr 2\\end{pmatrix}"],
    ["frac(1, 2) + abs(x) + norm(v)", "\\frac{1}{2} + \\left|x\\right| + \\left\\Vert v\\right\\Vert"],
    ["cal(L) = bb(E)", "\\mathcal{L} = \\mathbb{E}"],
    // Characters TeX reads as syntax are shown literally, as Typst does.
    ["p = 90% {1, 2}", "p = 90\\% \\{1, 2\\}"],
    // A script with nothing to apply to (a typo in the source) does not swallow the bracket.
    ["n L_n (w^)", "n L_{n} (w^{})"],
  ])("%s", (typst, expected) => {
    expect(tex(typst)).toBe(expected);
  });

  it("reports Typst names it does not translate", () => {
    expect(typstMathToTex("op(x) + zeta + mystery(y)").unknown).toEqual(["op", "mystery"]);
  });

  it("leaves input that is already TeX alone", () => {
    expect(typstMathToTex("\\frac{a}{b} times c")).toEqual({ tex: "\\frac{a}{b} times c", unknown: [] });
  });
});
