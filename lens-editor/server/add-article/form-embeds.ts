import { extractHtmlMeta } from "./fetch";
import type { ArticleMeta } from "./types";

/**
 * Online forms (Airtable, Google Forms, Tally) are imported as embed records,
 * not articles: a lens shows the form with `#### Embed` + `source::` this
 * article, and the platform frames the article's `source_url`. A form has no
 * text to extract, and Airtable answers server fetches with a near-empty page
 * that the bot-wall check rightly refuses, so a form URL skips extraction and
 * review: the record is written straight from the URL, with the form's title
 * when its page states one.
 */
export interface FormEmbed {
  /** The URL a frame loads: the provider's embed form of the submitted link. */
  embedUrl: string;
  /** The provider's name, used as author and as the title fallback. */
  provider: string;
}

export function formEmbedFromUrl(raw: string): FormEmbed | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "airtable.com") {
    // /app…/pag…/form, /app…/shr…, /shr…, each optionally behind /embed.
    const rest = parts[0] === "embed" ? parts.slice(1) : parts;
    const isForm =
      (rest.length === 3 && /^app\w+$/.test(rest[0]) && /^pag\w+$/.test(rest[1]) && rest[2] === "form") ||
      (rest.length === 2 && /^app\w+$/.test(rest[0]) && /^shr\w+$/.test(rest[1])) ||
      (rest.length === 1 && /^shr\w+$/.test(rest[0]));
    if (!isForm) return null;
    return { embedUrl: `https://airtable.com/embed/${rest.join("/")}`, provider: "Airtable" };
  }

  if (host === "docs.google.com" && parts[0] === "forms" && parts[1] === "d") {
    // /forms/d/e/<id>/viewform is the shareable form; /forms/d/<id>/edit is
    // the editor, which cannot be framed.
    if (parts[2] !== "e" || !parts[3]) return null;
    return {
      embedUrl: `https://docs.google.com/forms/d/e/${parts[3]}/viewform?embedded=true`,
      provider: "Google Forms",
    };
  }

  if (host === "tally.so" && (parts[0] === "r" || parts[0] === "embed") && parts[1]) {
    return { embedUrl: `https://tally.so/embed/${parts[1]}`, provider: "Tally" };
  }

  return null;
}

/** The form's title from its page's og:title or <title>, without the provider suffix. */
export function formTitleFromHtml(html: string, provider: string): string {
  const title = extractHtmlMeta(html)
    .title.replace(new RegExp(`\\s*[-–|]\\s*${provider}\\s*$`, "i"), "")
    .trim();
  return title.toLowerCase() === provider.toLowerCase() ? "" : title;
}

export function formEmbedMeta(form: FormEmbed, title: string, createdDate: string): ArticleMeta {
  return {
    title: title || `${form.provider} form`,
    author: [form.provider],
    source_url: form.embedUrl,
    published: createdDate,
    description: `An embedded ${form.provider} form. Show it in a lens with #### Embed and source:: this file.`,
  };
}
