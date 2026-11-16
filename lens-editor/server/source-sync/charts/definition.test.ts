import { describe, expect, it } from "vitest";
import { allowedUrl, dataUrl, iframeChart, pageUrl, tableChart } from "./definition";

describe("iframeChart", () => {
  it("is owid-<slug> for an OWID grapher page, whatever its query", () => {
    const chart = iframeChart("https://ourworldindata.org/grapher/annual-industrial-robots-installed?tab=chart");
    expect(chart).toMatchObject({ id: "owid-annual-industrial-robots-installed", source: { owid: "annual-industrial-robots-installed" }, rows: {} });
    expect(iframeChart("https://ourworldindata.org/grapher/annual-industrial-robots-installed/")?.hash).toBe(chart!.hash);
    expect(dataUrl(chart!)).toBe("https://ourworldindata.org/grapher/annual-industrial-robots-installed.csv?v=1&csvType=filtered&useColumnShortNames=true");
    expect(pageUrl(chart!)).toBe("https://ourworldindata.org/grapher/annual-industrial-robots-installed");
  });

  it("reads the entities a link selects, and takes OWID's map for no chart", () => {
    const chart = iframeChart("https://ourworldindata.org/grapher/test-scores?country=Handwriting+recognition~Speech+recognition&tab=chart&time=2020")!;
    expect(chart.source).toEqual({ owid: "test-scores", selection: ["Handwriting recognition", "Speech recognition"] });
    expect(dataUrl(chart)).toBe("https://ourworldindata.org/grapher/test-scores.csv?v=1&csvType=filtered&useColumnShortNames=true&country=Handwriting%20recognition~Speech%20recognition");
    expect(chart.hash).not.toBe(iframeChart("https://ourworldindata.org/grapher/test-scores")!.hash);
    expect(iframeChart("https://ourworldindata.org/grapher/electricity-generation?tab=map")).toBeNull();
    expect(tableChart(new Map([["source", "https://ourworldindata.org/grapher/electricity-generation?tab=map"]])).problems[0]).toMatch(/OWID's map of the chart/);
  });

  it("is no chart for any other embed, plain http, or another page of OWID", () => {
    for (const src of [
      "https://www.metaculus.com/questions/embed/38403?theme=light",
      "http://ourworldindata.org/grapher/x",
      "https://ourworldindata.org/artificial-intelligence",
      "https://ourworldindata.org/grapher/x.csv",
      "https://ourworldindata.org.evil.test/grapher/x",
      "",
    ]) {
      expect(iframeChart(src), src).toBeNull();
    }
    expect(allowedUrl("https://user@epoch.ai/data/x.csv")).toBeNull();
    expect(allowedUrl("https://epoch.ai:8443/data/x.csv")).toBeNull();
    expect(allowedUrl("https://epoch.ai/data/x.csv?q={++a++}")).toBeNull();
    expect(allowedUrl("https://epoch.ai/data/x%%.csv")).toBeNull();
  });
});

describe("tableChart", () => {
  const EPOCH = "https://epoch.ai/data/notable_ai_models.csv";
  const of = (rows: Record<string, string>) => tableChart(new Map(Object.entries(rows)));

  it("names a CSV chart <host word>-<dataset>-<hash>, a new id for new rows, and links its dataset page", () => {
    const { chart, problems } = of({ source: EPOCH, x: "Publication date", y: "Training compute (FLOP)", highlight: " GPT-4 ; ;AlexNet", y_scale: "LOG", kind: "Scatter" });
    expect(problems).toEqual([]);
    expect(chart).toMatchObject({ source: { csv: EPOCH }, rows: { kind: "scatter", x: "Publication date", y: "Training compute (FLOP)", highlight: ["GPT-4", "AlexNet"], yScale: "log" } });
    expect(chart!.id).toMatch(/^epoch-notable-ai-models-[0-9a-f]{8}$/);
    expect(chart!.id).toBe(`epoch-notable-ai-models-${chart!.hash.slice(0, 8)}`);
    expect(of({ source: EPOCH, x: "Publication date", y: "Parameters" }).chart!.id).not.toBe(chart!.id);
    expect(pageUrl(chart!)).toBe("https://epoch.ai/data/notable-ai-models");
    expect(of({ source: EPOCH, x: "a", y: "b", id: "compute-trend" }).chart!.id).toBe("compute-trend");
  });

  it("draws an OWID chart as OWID does: only title, y_scale and highlight apply", () => {
    const { chart, problems } = of({ source: "https://ourworldindata.org/grapher/child-mortality", kind: "line", x: "year", title: "Child deaths" });
    expect(chart).toMatchObject({ source: { owid: "child-mortality" }, rows: { title: "Child deaths" } });
    expect(chart!.id).toMatch(/^owid-child-mortality-[0-9a-f]{8}$/);
    expect(problems).toEqual(["the rows kind, x apply to a CSV source only; an OWID chart is drawn as OWID draws it"]);
  });

  it("refuses a table it cannot draw, saying why", () => {
    const problem = (rows: Record<string, string>) => of(rows).problems[0];
    expect(problem({})).toMatch(/needs a source row/);
    expect(problem({ source: "https://example.org/data.csv" })).toMatch(/is not an https link to ourworldindata.org or epoch.ai/);
    expect(problem({ source: EPOCH, x: "a" })).toMatch(/needs x and y rows/);
    expect(problem({ source: EPOCH, x: "a", y: "b", kind: "pie" })).toMatch(/kind "pie"/);
    expect(problem({ source: EPOCH, x: "a", y: "b", y_scale: "symlog" })).toMatch(/y_scale "symlog"/);
    expect(problem({ source: EPOCH, x: "a", y: "b", id: "Not_An_Id" })).toMatch(/id "Not_An_Id"/);
    expect(of({ source: EPOCH }).chart).toBeNull();
  });
});
