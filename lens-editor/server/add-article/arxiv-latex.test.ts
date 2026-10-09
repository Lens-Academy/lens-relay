import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  arxivSourceToHtml,
  attachFigures,
  expandRestatable,
  findMainTex,
  graphicsPathDirs,
  flattenArxivSource,
  harvestMacroDefinitions,
  keepXspaceSpaces,
  numberEquations,
  resolveEquationLinks,
  parseBiblatexBbl,
  parseBibitemBbl,
  rasterizePdfFigure,
  replaceCitations,
  runPandoc,
  stripComments,
  unpackArxivSource,
} from "./arxiv-latex";
import { extractArticle } from "./extract";
import { cleanLatexMath } from "./adapters/arxiv";
import { normalizeArticleBody } from "./normalize-article";

/** A ustar archive of `files` (what arxiv.org/e-print serves, gzipped). */
function tarOf(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("00000000000\0", 136, "latin1");
    header.write("        ", 148, "latin1");
    header.write("0", 156, "latin1");
    header.write("ustar\0", 257, "latin1");
    header.write("00", 263, "latin1");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const filesOf = (record: Record<string, string>) =>
  new Map(Object.entries(record).map(([k, v]) => [k, Buffer.from(v, "utf8")]));

const hasPandoc = spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"]).status === 0;

describe("unpackArxivSource", () => {
  it("unpacks a gzipped tar, a single gzipped .tex, and refuses a PDF-only e-print", () => {
    const tar = zlib.gzipSync(tarOf({ "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}", "fig/a.png": "png" }));
    const files = unpackArxivSource(tar)!;
    expect([...files.keys()].sort()).toEqual(["fig/a.png", "main.tex"]);

    const single = unpackArxivSource(zlib.gzipSync("\\documentclass{article}\\begin{document}y\\end{document}"))!;
    expect([...single.keys()]).toEqual(["main.tex"]);

    expect(unpackArxivSource(Buffer.from("%PDF-1.5 paper"))).toBeNull();
    expect(() => unpackArxivSource(zlib.gzipSync("%PDF-1.5 paper"))).toThrow(/gzipped PDF/);
    // An old PostScript submission is neither: the candidate fails.
    expect(() => unpackArxivSource(zlib.gzipSync("%!PS-Adobe-2.0 %%Title: Old Paper"))).toThrow(/neither LaTeX nor a PDF/);
  });

  it("drops archive members that point outside the archive", () => {
    const files = unpackArxivSource(tarOf({ "../../etc/x.tex": "evil", "/abs.tex": "evil", "ok/./main.tex": "fine" }))!;
    expect([...files.keys()]).toEqual(["ok/main.tex"]);
  });
});

describe("findMainTex", () => {
  it("picks the file with \\documentclass and a document body, ignoring commented-out ones", () => {
    const files = filesOf({
      "sections/intro.tex": "\\section{Intro}",
      "old.tex": "% \\documentclass{article}\n% \\begin{document}",
      "paper.tex": "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}",
    });
    expect(findMainTex(files)).toBe("paper.tex");
    expect(findMainTex(filesOf({ "a.tex": "\\section{x}" }))).toBeNull();
  });
});

describe("flattenArxivSource", () => {
  it("inlines \\input files, local package macros and drops comments", () => {
    const files = filesOf({
      "main.tex": [
        "\\documentclass{article}",
        "\\usepackage{amsmath,mymacros}",
        "\\begin{document}",
        "\\input{sections/intro}",
        "% \\input{sections/secret}",
        "\\input{/etc/passwd}",
        "\\input{../outside}",
        "\\end{document}",
      ].join("\n"),
      "sections/intro.tex": "Intro text with $\\RR$.",
      "sections/secret.tex": "SECRET",
      "mymacros.sty": [
        "\\ProvidesPackage{mymacros}",
        "\\newcommand{\\RR}{\\mathbb{R}}",
        "\\DeclareMathOperator{\\Var}{Var}",
        "\\def\\copyright@year{2016}",
        "\\renewcommand{\\footnotesize}{\\fontsize{10pt}{14pt}\\selectfont}",
        "\\newcommand{\\maketitle}{\\vbox{x}}",
      ].join("\n"),
    });
    const tex = flattenArxivSource(files, "main.tex");
    expect(tex).toContain("Intro text with $\\RR$.");
    expect(tex).toContain("\\newcommand{\\RR}{\\mathbb{R}}");
    expect(tex).toContain("\\DeclareMathOperator{\\Var}{Var}");
    expect(tex).toContain("\\usepackage{amsmath}");
    expect(tex).not.toContain("mymacros");
    expect(tex).not.toContain("SECRET");
    expect(tex).not.toContain("copyright@year");
    expect(tex).not.toContain("fontsize");
    expect(tex).not.toContain("\\vbox");
    expect(tex).not.toContain("passwd");
  });

  it("splices bibliography labels into citations and adds the reference list", () => {
    const files = filesOf({
      "main.tex": [
        "\\documentclass{article}",
        "\\usepackage{natbib}",
        "\\begin{document}",
        "As \\citet{gibbard} argue, and others agree \\citep[see][p.~3]{gibbard,lewis}.",
        "\\bibliographystyle{plainnat}",
        "\\bibliography{refs}",
        "\\end{document}",
      ].join("\n"),
      "main.bbl": [
        "\\begin{thebibliography}{2}",
        "\\bibitem[{Gibbard and Harper}(1978)]{gibbard} Allan Gibbard and William Harper. \\newblock Counterfactuals. 1978.",
        "\\bibitem[{Lewis}(1979)]{lewis} David Lewis. \\newblock Prisoner's dilemma. 1979.",
        "\\end{thebibliography}",
      ].join("\n"),
    });
    const tex = flattenArxivSource(files, "main.tex");
    expect(tex).toContain("As Gibbard and Harper (1978) argue, and others agree (see Gibbard and Harper 1978; Lewis 1979, p.~3).");
    expect(tex).toContain("\\section*{References}");
    expect(tex).toContain("\\item {}Allan Gibbard and William Harper.");
    expect(tex).not.toContain("\\bibliographystyle");
  });
});

describe("numberEquations", () => {
  it("numbers equations like LaTeX and resolves references to them", () => {
    const tex = [
      "\\begin{equation}a\\label{eq:a}\\end{equation}",
      "\\begin{equation*}u\\end{equation*}",
      "\\begin{align}b \\label{eq:b}\\\\ c \\nonumber\\\\ d \\label{eq:d}\\end{align}",
      "\\begin{equation}e\\tag{$\\star$}\\label{eq:e}\\end{equation}",
      "See \\eqref{eq:a}, \\ref{eq:d}, \\eqref{eq:e} and \\ref{sec:x}.",
    ].join("\n");
    const out = numberEquations(tex);
    expect(out).toContain("\\begin{equation}a\\label{eq:a}\\tag{1}\\end{equation}");
    expect(out).toContain("See (1), 3, ($\\star$) and \\ref{sec:x}.");
    expect(numberEquations("\\numberwithin{equation}{section}" + tex)).toBe("\\numberwithin{equation}{section}" + tex);
  });

  it("resolves equation links pandoc met only through a macro", () => {
    const html = 'see <a href="#eq:edt" data-reference-type="eqref" data-reference="eq:edt">[eq:edt]</a> and <a href="#x" data-reference-type="ref" data-reference="x">[x]</a>';
    expect(resolveEquationLinks(html, new Map([["eq:edt", "2"]]))).toBe(
      'see (2) and <a href="#x" data-reference-type="ref" data-reference="x">[x]</a>',
    );
  });

  it("keeps $ sequences in references literal", () => {
    const files = filesOf({
      "main.tex": "\\documentclass{article}\\begin{document}Body \\citep{a}.\n\\end{document}",
      "main.bbl": "\\begin{thebibliography}{1}\n\\bibitem[Ann(2001)]{a} Ann, B. \\newblock \\emph{On $f$'s complexity and $`x$}.\n\\end{thebibliography}",
    });
    const tex = flattenArxivSource(files, "main.tex");
    expect(tex).toContain("\\emph{On $f$'s complexity and $`x$}.");
    expect(tex.match(/\\documentclass/g)).toHaveLength(1);
  });
});

describe("inline bibliographies and fan-out", () => {
  it("reads a thebibliography written out in the document when there is no .bbl", () => {
    const files = filesOf({
      "main.tex": [
        "\\documentclass{article}\n\\begin{document}",
        "As \\citet{gibbard} argue, see also \\citep{lewis}.",
        "\\begin{thebibliography}{2}",
        "\\bibitem[{Gibbard and Harper}(1978)]{gibbard} Allan Gibbard. Counterfactuals. 1978.",
        "\\bibitem[{Lewis}(1979)]{lewis} David Lewis. Prisoners. 1979.",
        "\\end{thebibliography}",
        "\\end{document}",
      ].join("\n"),
    });
    const tex = flattenArxivSource(files, "main.tex");
    expect(tex).toContain("As Gibbard and Harper (1978) argue, see also (Lewis 1979).");
    expect(tex).toContain("\\item {}Allan Gibbard. Counterfactuals. 1978.");
    expect(tex).not.toContain("thebibliography");
  });

  it("refuses an \\input fan-out bomb instead of expanding it", () => {
    const record: Record<string, string> = { "main.tex": "\\documentclass{article}\\begin{document}\\input{f0}\\end{document}" };
    for (let i = 0; i < 20; i += 1) record[`f${i}.tex`] = `${"x".repeat(1000)}\\input{f${i + 1}}\\input{f${i + 1}}`;
    record["f20.tex"] = "leaf";
    expect(() => flattenArxivSource(filesOf(record), "main.tex")).toThrow(/too (large|many)/);
  });
});

describe("bibliography parsing", () => {
  it("reads biblatex .bbl entries (Logical Induction, FDT)", () => {
    const bbl = [
      "\\entry{Aaronson:2013}{incollection}{}",
      "  \\name{author}{1}{}{%",
      "    {{hash=1}{family={Aaronson}, familyi={A\\bibinitperiod}, given={Scott}, giveni={S\\bibinitperiod}}}%",
      "  }",
      "  \\field{title}{Why philosophers should care about computational complexity}",
      "  \\field{booktitle}{Computability}",
      "  \\field{year}{2013}",
      "\\endentry",
      "\\entry{GHS}{article}{}",
      "  \\name{author}{3}{}{%",
      "    {{hash=2}{family={Garrabrant}, given={Scott}}}%",
      "    {{hash=3}{family={Benson-Tilsen}, given={Tsvi}}}%",
      "    {{hash=4}{family={Critch}, given={Andrew}}}%",
      "  }",
      "  \\field{year}{2016}",
      "\\endentry",
    ].join("\n");
    const entries = parseBiblatexBbl(bbl);
    expect(entries.map((e) => [e.key, e.authors, e.year])).toEqual([
      ["Aaronson:2013", "Aaronson", "2013"],
      ["GHS", "Garrabrant et al.", "2016"],
    ]);
    expect(entries[0].reference).toBe(
      "Aaronson, Scott. 2013. \\emph{Why philosophers should care about computational complexity}. Computability.",
    );
  });

  it.skipIf(!hasPandoc)("keeps the numbers of a numeric reference list through pandoc", async () => {
    const files = filesOf({
      "main.tex": "\\documentclass{article}\n\\begin{document}\nAs shown \\cite{a} and \\cite{b}.\n\\bibliography{refs}\n\\end{document}",
      "main.bbl": "\\begin{thebibliography}{2}\n\\bibitem{a} Alice Author. First paper. 2001.\n\\bibitem{b} Bob Builder. Second paper. 2002.\n\\end{thebibliography}",
    });
    const html = await runPandoc(flattenArxivSource(files, "main.tex"));
    expect(html).toContain("As shown [1] and [2].");
    expect(html).toContain("[1] Alice Author. First paper. 2001.");
    expect(html).toContain("[2] Bob Builder. Second paper. 2002.");
  });

  it("numbers citations for numeric bibliographies", () => {
    const entries = parseBibitemBbl("\\begin{thebibliography}{9}\n\\bibitem{a} A.\n\\bibitem{b} B.\n\\end{thebibliography}");
    expect(replaceCitations("See \\cite{a,b} and \\cite{b}.", entries, "numeric")).toBe("See [1, 2] and [2].");
  });
});

describe("LaTeX preprocessing", () => {
  it("strips comments but keeps escaped percent signs, URLs and verbatim text", () => {
    expect(stripComments("50\\% done % a note\nnext")).toBe("50\\% done next");
    // A comment before a blank line keeps the paragraph break.
    expect(stripComments("First paragraph ends here. % note\n\nSecond paragraph.")).toBe("First paragraph ends here. \n\nSecond paragraph.");
    // A comment-only line inside a paragraph keeps it one paragraph.
    expect(stripComments("First half,\n% TODO cite\nand the second half.")).toBe("First half,\nand the second half.");
    expect(stripComments("See \\url{http://a.com/x%20y} for data. % note")).toBe("See \\url{http://a.com/x%20y} for data. ");
    expect(stripComments("\\begin{verbatim}\nx = 100 % 7\n\\end{verbatim}")).toBe("\\begin{verbatim}\nx = 100 % 7\n\\end{verbatim}");
    expect(stripComments("% \\url{http://a.com/%}\nkept")).toBe("kept");
  });

  it("rewrites thm-restate theorems into plain theorem environments, restatements included", () => {
    const tex = "\\begin{restatable}[Convergence]{theorem}{thmconv}\nP converges.\n\\end{restatable}\nLater: \\thmconv*";
    const out = expandRestatable(tex);
    expect(out).not.toContain("restatable");
    expect(out.match(/\\begin\{theorem\}\[Convergence\]\nP converges\.\n\\end\{theorem\}/g)).toHaveLength(2);
  });

  it("keeps the space after an \\xspace macro", () => {
    const tex = "\\newcommand{\\Act}{\\Var{Act}\\xspace}\nThe \\Act is chosen, and \\Act, too.";
    expect(keepXspaceSpaces(tex)).toContain("The \\Act{} is chosen, and \\Act, too.");
  });

  it("keeps notation macros and leaves typesetting machinery out", () => {
    const sty = [
      "\\newcommand{\\PP}{\\mathbb{P}}",
      "\\newcommand\\EE[1][]{\\mathbb{E}_{#1}}",
      "\\def\\NN{\\mathbb{N}}",
      "\\def\\@maketitle{\\vbox{}}",
      "\\newcommand{\\squelch}[1]{\\BeginAccSupp{x}#1\\EndAccSupp{}}",
      "\\renewcommand{\\section}{\\@startsection}",
    ].join("\n");
    expect(harvestMacroDefinitions(sty).split("\n")).toEqual([
      "\\newcommand{\\PP}{\\mathbb{P}}",
      "\\newcommand\\EE[1][]{\\mathbb{E}_{#1}}",
      "\\providecommand{\\NN}{\\mathbb{N}}",
    ]);
  });
});

describe("cleanLatexMath", () => {
  it("removes what KaTeX rejects or Markdown would break on, keeping the mathematics", () => {
    expect(cleanLatexMath("\\mathcal{EU}(a) \\label{eq:umax}\\nonumber")).toBe("\\mathcal{EU}(a)");
    expect(cleanLatexMath("\\ensuremath{\\mathcal U}(o)")).toBe("{\\mathcal U}(o)");
    expect(cleanLatexMath("\\mathcal{B\\-C\\-S}")).toBe("\\mathcal{BCS}");
    expect(cleanLatexMath("\\phi := ``x > 3\"")).toBe("\\phi := \\text{“}x > 3\\text{”}");
    expect(cleanLatexMath("-\\$b")).toBe("-\\text{\\textdollar}b");
    expect(cleanLatexMath("\\operatorname{Ind}_{\\text{\\small{${\\delta}$}}}")).toBe(
      "\\operatorname{Ind}_{\\text{\\small{\\({\\delta}\\)}}}",
    );
    expect(cleanLatexMath("M\\textsuperscript{\\(a\\hookrightarrow\\)}")).toBe("M^{\\text{\\(a\\hookrightarrow\\)}}");
    expect(cleanLatexMath("P(\\textsc{Outcome})")).toBe("P(\\text{Outcome})");
    expect(cleanLatexMath("a \\\\\n\n b")).toBe("a \\\\\n b");
  });
});

describe("attachFigures", () => {
  it("hosts raster figures, draws PDF figures, and drops what cannot be shown, keeping captions", async () => {
    const files = new Map([
      ["figs/plot.png", Buffer.from("png-bytes")],
      ["figs/diagram.pdf", Buffer.from("%PDF diagram")],
      ["figs/broken.pdf", Buffer.from("%PDF broken")],
      ["figs/old.eps", Buffer.from("%!PS")],
    ]);
    const drawn = Buffer.from("\x89PNG drawn");
    const rasterize = async (pdf: Buffer) => (pdf.toString().includes("diagram") ? drawn : null);
    const html = [
      `<figure><img src="figs/plot.png" alt="Plot"><figcaption>One</figcaption></figure>`,
      `<figure><embed src="figs/diagram.pdf" style="width:54.0%" /><figcaption>Two</figcaption></figure>`,
      `<figure><img src="figs/broken.pdf"><figcaption>Three</figcaption></figure>`,
      `<figure><img src="figs/old.eps"><figcaption>Four</figcaption></figure>`,
      `<img src="figs/plot">`,
    ].join("");
    const out = await attachFigures(html, files, "", rasterize);
    expect(out.images).toHaveLength(2);
    expect(out.images[0]).toMatchObject({ png: Buffer.from("png-bytes"), mime: "image/png" });
    expect(out.images[1]).toMatchObject({ png: drawn, mime: "image/png" });
    expect(out.html).toBe(
      [
        `<figure><img src="lens-source-image:0" alt="Plot"><figcaption>One</figcaption></figure>`,
        `<figure><img src="lens-source-image:1" alt=""><figcaption>Two</figcaption></figure>`,
        `<figure><figcaption>Three</figcaption></figure>`,
        `<figure><figcaption>Four</figcaption></figure>`,
        `<img src="lens-source-image:0" alt="">`,
      ].join(""),
    );
  });
});

describe("graphicsPathDirs", () => {
  it("finds figures in the \\graphicspath directories", async () => {
    expect(graphicsPathDirs("\\graphicspath{{figures/}{img/}}")).toEqual(["figures/", "img/"]);
    const files = new Map([["figures/plot.png", Buffer.from("png")]]);
    const out = await attachFigures('<img src="plot">', files, "", async () => null, undefined, ["figures/"]);
    expect(out.images).toHaveLength(1);
    expect(out.html).toBe('<img src="lens-source-image:0" alt="">');
  });
});

const hasPdftoppm = spawnSync(process.env.PDFTOPPM_PATH || "pdftoppm", ["-v"]).status === 0;

describe.skipIf(!hasPdftoppm)("rasterizePdfFigure", () => {
  it("draws a PDF figure to PNG and returns null for junk", async () => {
    const pdf = await import("node:fs/promises").then((fs) =>
      fs.readFile("server/add-article/eval/fixtures-pdf/needforbias-1980/article.pdf"),
    );
    const png = await rasterizePdfFigure(pdf);
    expect(png?.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(await rasterizePdfFigure(Buffer.from("not a pdf"))).toBeNull();
  });
});

describe.skipIf(!hasPandoc)("arXiv e-print to article (pandoc)", () => {
  it("leaves the title empty, not a placeholder, when pandoc sees no \\title", async () => {
    const body = `\\documentclass{article}\n\\begin{document}\n${"Plain paper text without a title block. ".repeat(20)}\n\\end{document}`;
    const converted = (await arxivSourceToHtml(zlib.gzipSync(body)))!;
    expect(converted.html).toContain("<title></title>");
    const ex = await extractArticle(converted.html, "https://arxiv.org/src/2210.10760", { sourceUrl: "https://arxiv.org/abs/2210.10760" });
    expect(ex.meta.title).not.toMatch(/arxiv|untitled/i);
  });

  it("reads ICML-style titles and \\And-separated authors", async () => {
    const body = `\\documentclass{article}\n\\icmltitle{Scaling Laws for Reward Model Overoptimization}\n\\author{Leo Gao\\\\OpenAI \\And John Schulman\\\\OpenAI}\n\\begin{document}\n\\maketitle\n${"Body text. ".repeat(80)}\n\\end{document}`;
    const converted = (await arxivSourceToHtml(zlib.gzipSync(body)))!;
    const ex = await extractArticle(converted.html, "https://arxiv.org/src/2210.10760", { sourceUrl: "https://arxiv.org/abs/2210.10760" });
    expect(ex.meta.title).toBe("Scaling Laws for Reward Model Overoptimization");
    expect(ex.meta.author).toEqual(["Leo Gao", "John Schulman"]);
  });

  it("reads nothing outside the document it is given (--sandbox)", async () => {
    const html = await runPandoc("\\documentclass{article}\\begin{document}A \\input{/etc/hostname} B\\end{document}");
    const host = spawnSync("cat", ["/etc/hostname"]).stdout.toString().trim();
    expect(html).toContain("A");
    if (host) expect(html).not.toContain(host);
  });

  it("converts a paper's LaTeX into Markdown with its math, citations and figures", async () => {
    const tex = [
      "\\documentclass{article}",
      "\\usepackage{mathnotation}",
      "\\title{Logical Induction}",
      "\\author{Scott Garrabrant\\thanks{MIRI}\\\\Machine Intelligence Research Institute \\And Tsvi Benson-Tilsen\\\\MIRI}",
      "\\begin{document}",
      "\\maketitle",
      "\\begin{abstract}We present a computable algorithm.\\end{abstract}",
      "\\section{Introduction}\\label{sec:intro}",
      "A market $\\PP$ prices sentences; a trader who pays \\$1 per share profits \\citep{aaronson}.",
      "Prices satisfy $\\PP_n(\\phi)\\in[0,1]$$\\phi$ for all $n$.",
      "\\begin{equation}\\label{eq:main}",
      "  \\lim_{n\\to\\infty} \\PP_n(\\phi) = 1",
      "\\end{equation}",
      "As shown in Section~\\ref{sec:intro}.",
      "\\begin{figure}\\includegraphics{market}\\caption{A market.}\\end{figure}",
      `${"Logical inductors learn to predict patterns long before they can prove them. ".repeat(8)}`,
      "\\begin{table}\\caption{Prices by day.}\\begin{tabular}{ll}Day & Price\\\\\\hline 1 & 0.5\\end{tabular}\\end{table}",
      "\\section{Conclusion}",
      "Done.\\footnote{A note.}",
      "\\bibliography{refs}",
      "\\end{document}",
    ].join("\n");
    const tar = zlib.gzipSync(
      tarOf({
        "main.tex": tex,
        "mathnotation.sty": "\\newcommand{\\PP}{\\mathbb{P}}",
        "main.bbl": "\\begin{thebibliography}{1}\n\\bibitem[{Aaronson}(2013)]{aaronson} Scott Aaronson. Why philosophers should care. 2013.\n\\end{thebibliography}",
        "market.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }),
    );
    const converted = (await arxivSourceToHtml(tar))!;
    expect(converted.images).toHaveLength(1);

    const ex = await extractArticle(converted.html, "https://arxiv.org/src/1609.03543", {
      sourceUrl: "https://arxiv.org/abs/1609.03543",
      sourceImages: converted.images,
    });
    expect(ex.via).toBe("arxiv");
    expect(ex.meta.title).toBe("Logical Induction");
    expect(ex.meta.author).toEqual(["Scott Garrabrant", "Tsvi Benson-Tilsen"]);
    expect(ex.images).toBe(converted.images);
    const body = normalizeArticleBody(ex.body, "https://arxiv.org/abs/1609.03543").body;
    expect(body).toContain("## Abstract");
    expect(body).toMatch(/^## Introduction/m);
    expect(body).toContain("We present a computable algorithm.");
    expect(body).toContain("A market $\\mathbb{P}$ prices sentences; a trader who pays \\$1 per share profits (Aaronson 2013).");
    // Two adjacent formulas become one, never `$…$$…$`.
    expect(body).toContain("$\\mathbb{P}_n(\\phi)\\in[0,1] \\phi$");
    // Display math is fenced and loses its \label.
    expect(body).toMatch(/\n\$\$\n\\lim_\{n\\to\\infty\} \\mathbb\{P\}_n\(\\phi\) = 1\n\\tag\{1\}\n\$\$\n/);
    expect(body).not.toContain("\\label");
    expect(body).toContain("![[__pdfimg_0__]]");
    expect(body).toContain("A market.");
    // The caption is its own paragraph, so the pipe table after it survives.
    expect(body).toMatch(/Prices by day\.\n\n\| Day \| Price \|/);
    expect(body).toMatch(/\[\^[\w-]+\]: A note\./);
    expect(body).toContain("Scott Aaronson. Why philosophers should care. 2013.");
  });
});
