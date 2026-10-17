import { describe, expect, it } from "vitest";
import { expandMacros, redefinitionsAsDef, takeDefinitions, type Macros } from "./mdx-macros";

/** The table a page's opening formula defines. */
function table(definitions: string): Macros {
  const macros: Macros = new Map();
  expect(takeDefinitions(definitions, macros)).toBe("");
  return macros;
}

describe("takeDefinitions", () => {
  it("reads every \\gdef of a formula and leaves the rest of it", () => {
    const macros: Macros = new Map();
    expect(takeDefinitions("\\gdef\\cM{\\mathcal{M}}x + \\gdef\\dv#1#2{\\frac{d #1}{d #2}}y", macros)).toBe("x + y");
    expect(Object.fromEntries(macros)).toEqual({
      cM: { params: 0, body: "\\mathcal{M}" },
      dv: { params: 2, body: "\\frac{d #1}{d #2}" },
    });
  });

  it("leaves a \\gdef it cannot read where it is", () => {
    const macros: Macros = new Map();
    expect(takeDefinitions("\\gdef\\broken{x", macros)).toBe("\\gdef\\broken{x");
    expect(macros.size).toBe(0);
  });
});

describe("expandMacros", () => {
  const macros = table(
    "\\gdef\\cM{\\mathcal{M}}\\gdef\\KL{D_{\\text{KL}}}\\gdef\\CL{{\\mathcal L}}" +
      "\\gdef\\pref{\\succcurlyeq}\\gdef\\argmax{\\operatorname*{arg\\,max}}\\gdef\\plt{\\mathrel{\\stackrel{+}{<}}}" +
      "\\gdef\\dv#1#2{\\frac{d #1}{d #2}}\\gdef\\bv#1{\\boldsymbol{#1}}\\gdef\\Sn#1#2{S_{n}(#1 \\parallel #2)}" +
      "\\gdef\\abs#1{\\left| #1 \\right|}\\gdef\\Ex{\\mathbb{E}}\\gdef\\EX{\\Ex_{x}}\\gdef\\loop{\\loop}",
  );
  const expand = (tex: string) => expandMacros(tex, macros);

  it("puts the body of a macro without arguments in braces", () => {
    expect(expand("\\mu \\in \\cM")).toBe("\\mu \\in {\\mathcal{M}}");
    expect(expand("\\KL(p \\| q)^2 + \\CL(\\theta)")).toBe("{D_{\\text{KL}}}(p \\| q)^2 + {{\\mathcal L}}(\\theta)");
  });

  it("leaves bare a body that braces would change: one symbol, an operator, a relation", () => {
    expect(expand("h\\pref h'")).toBe("h\\succcurlyeq h'");
    expect(expand("\\argmax_{a} Q(a)")).toBe("\\operatorname*{arg\\,max}_{a} Q(a)");
    expect(expand("K \\plt b")).toBe("K \\mathrel{\\stackrel{+}{<}} b");
  });

  it("puts the arguments into the body of a macro that takes them", () => {
    expect(expand("\\dv{x}{t}= f(x)")).toBe("\\frac{d x}{d t}= f(x)");
    expect(expand("\\bv\\mu + \\bv w + \\bv{w}")).toBe("\\boldsymbol{\\mu} + \\boldsymbol{w} + \\boldsymbol{w}");
    expect(expand("\\Sn{\\nu}{\\rho}")).toBe("S_{n}(\\nu \\parallel \\rho)");
  });

  it("keeps a control word apart from a letter the expansion puts next to it", () => {
    expect(expand("\\beta\\Sn{a}{b}")).toBe("\\beta S_{n}(a \\parallel b)");
  });

  it("expands a macro inside a macro, and stops at one that uses itself", () => {
    const problems: string[] = [];
    expect(expand("\\EX[f]")).toBe("{{\\mathbb{E}}_{x}}[f]");
    expect(expandMacros("\\loop", macros, { onProblem: (reason) => problems.push(reason) })).toContain("\\loop");
    expect(problems).toEqual(["macro \\loop uses itself"]);
  });

  it("leaves a macro without its arguments as written, and says so", () => {
    const problems: string[] = [];
    expect(expandMacros("\\dv{x}", macros, { onProblem: (reason) => problems.push(reason) })).toBe("\\dv{x}");
    expect(problems).toEqual(["macro \\dv takes 2 argument(s), and 1 follow it"]);
  });

  it("touches neither other commands nor the name a definition defines", () => {
    expect(expand("\\cMx + \\mathcal{M} + \\\\cM")).toBe("\\cMx + \\mathcal{M} + \\\\cM");
    expect(expand("\\def\\cM{1}\\renewcommand{\\cM}{2}")).toBe("\\def\\cM{1}\\renewcommand{\\cM}{2}");
  });

  it("writes no bare | in a table row, where it would end the cell", () => {
    expect(expandMacros("\\abs{x}", macros, { inTable: true })).toBe("\\left\\vert  x \\right\\vert ");
    expect(expand("\\abs{x}")).toBe("\\left| x \\right|");
  });
});

describe("redefinitionsAsDef", () => {
  it("turns \\renewcommand into \\def, which needs no earlier definition", () => {
    expect(redefinitionsAsDef("\\renewcommand{\\arraystretch}{1.8}\\begin{array}{c}a\\end{array}")).toBe("\\def\\arraystretch{1.8}\\begin{array}{c}a\\end{array}");
    expect(redefinitionsAsDef("\\renewcommand\\p[2]{#1/#2}")).toBe("\\def\\p#1#2{#1/#2}");
  });
});
