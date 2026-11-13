/**
 * For the Atlas sync tests: a course of two small chapter Docs, kept as
 * plain values a test edits (retitle a section, drop one, change a word),
 * and Docs and files in memory.
 */

import { heading, image, table, text } from "../../google-docs/__fixtures__/docs";
import type { DocsDocument, StructuralElement } from "../../google-docs/docs-types";
import { memoryFiles } from "../../iliad/__fixtures__/files/course";
import type { AtlasDocs } from "../snapshot";
import type { AtlasCourseConfig } from "../types";

export const DOC1 = "1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const DOC2 = "1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const link = (doc: string, tab = "t.0") => `https://docs.google.com/document/d/${doc}/edit?tab=${tab}`;

export const CONFIG: AtlasCourseConfig = {
  course: "Lens Edu/courses/in-development/Atlas Test.md",
  slug: "atlas-test",
  title: "Atlas Test",
  folder: "Atlas Test",
  filePrefix: "Atlas",
  moduleSlugPrefix: "atlas-",
  siteUrl: "https://atlas.test/chapters/v1",
  authors: ["Markov Grey", "Charbel-Raphaël Segerie"],
  chapters: [{ doc: link(DOC1), acknowledgements: ["Jeanne Salle", "Charles Martinet", "Léo Dana"] }, { doc: link(DOC2), authors: ["Markov Grey"] }],
  courseFields: { "partner-name": "AI Safety Atlas" },
};

export interface SectionSpec {
  title: string;
  /** The heading's `headingId`, which the Doc keeps through a rename; none when null. */
  heading?: string | null;
  /** Words of the section's paragraph; each section's are its own, so fingerprints tell them apart. */
  words: string[];
  description?: string;
  image?: string;
}

export interface ChapterSpec {
  number: number;
  title: string;
  sections: SectionSpec[];
}

const letter = (n: number) => String.fromCharCode(97 + (n % 26));
/** `n` words no other section has ("<seed>aa <seed>ba ..."), with a common one every fifth word. */
export const wordsOf = (seed: string, n = 60): string[] => Array.from({ length: n }, (_, i) => (i % 5 === 4 ? "the" : `${seed}${letter(i)}${letter(Math.floor(i / 26))}`));

export const describes = (s: string) => table([["type", [text("section-description")]], ["content", [text(s)]]]);
const figure = (id: string) => table([["type", [text("figure")]], ["content", [image(id)]], ["caption", [text(`Caption ${id}.`)]]]);

export function chapterDoc(docId: string, spec: ChapterSpec, titleText = `Chapter ${spec.number} - ${spec.title}`): DocsDocument {
  const content: StructuralElement[] = [heading("TITLE", titleText)];
  const images: string[] = [];
  for (const section of spec.sections) {
    const h1 = heading(1, section.title);
    if (section.heading) h1.paragraph!.paragraphStyle!.headingId = section.heading;
    content.push(h1);
    if (section.description) content.push(describes(section.description));
    content.push(text(section.words.join(" ")));
    if (section.image) {
      content.push(figure(section.image));
      images.push(section.image);
    }
  }
  return {
    documentId: docId,
    tabs: [
      {
        tabProperties: { tabId: "t.0", title: "Chapter" },
        documentTab: {
          body: { content },
          inlineObjects: Object.fromEntries(images.map((id) => [id, { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: `https://lh.test/${id}?sig=${Math.random()}` } } } }])),
        },
      },
    ],
  };
}

/** The two chapters as a test starts them; a test changes its own copy. */
export const CHAPTERS = (): ChapterSpec[] => [
  {
    number: 1,
    title: "Capabilities",
    sections: [
      { title: "Introduction", heading: "h.intro", words: wordsOf("intro"), description: "Why capabilities matter.", image: "kix.one" },
      { title: "Foundation Models", heading: "h.found", words: wordsOf("found") },
      { title: "Scaling", heading: "h.scal", words: wordsOf("scal") },
      { title: "Forecasting", heading: "h.fore", words: wordsOf("fore") },
      { title: "Takeoff", heading: "h.take", words: wordsOf("take") },
      { title: "Appendix: Expert Surveys", heading: "h.appx", words: wordsOf("appx") },
    ],
  },
  {
    number: 2,
    title: "Risks",
    sections: [
      { title: "Risk Decomposition", heading: "h.risk", words: wordsOf("risk") },
      { title: "Misuse", heading: "h.misu", words: wordsOf("misu") },
    ],
  },
];

/** Docs in memory, made from `specs` when read, so a test edits the specs between runs. */
export function memoryDocs(specs: ChapterSpec[], docIds = [DOC1, DOC2]): AtlasDocs & { reads: string[]; images: string[]; fail: Map<string, Error>; titles: Map<string, string> } {
  const reads: string[] = [];
  const images: string[] = [];
  const fail = new Map<string, Error>();
  const titles = new Map<string, string>();
  return {
    reads,
    images,
    fail,
    titles,
    async getDocument(id) {
      reads.push(id);
      const failure = fail.get(id);
      if (failure) throw failure;
      const i = docIds.indexOf(id);
      if (i < 0) throw new Error(`Google Doc ${id} is not readable (404)`);
      return chapterDoc(id, specs[i], titles.get(id));
    },
    async getImage({ docId, inlineObjectId }) {
      images.push(`${docId}#${inlineObjectId}`);
      return new Uint8Array([1, 2, 3]);
    },
  };
}

/** Lens Edu in memory, empty. */
export const emptyFiles = () => memoryFiles({});
