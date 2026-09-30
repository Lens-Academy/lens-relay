/**
 * The slice of the Google Docs API v1 `Document` shape the sync reads.
 * https://developers.google.com/docs/api/reference/rest/v1/documents
 * Declared here rather than pulling in `googleapis` for its types.
 */

export interface DocsDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  tabs?: DocsTab[];
}

export interface DocsTab {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: DocumentTab;
  childTabs?: DocsTab[];
}

export interface DocumentTab {
  body?: { content?: StructuralElement[] };
  footnotes?: Record<string, { content?: StructuralElement[] }>;
  lists?: Record<string, { listProperties?: { nestingLevels?: NestingLevel[] } }>;
  inlineObjects?: Record<string, InlineObject>;
}

export interface NestingLevel {
  glyphType?: string;
  glyphSymbol?: string;
}

export interface InlineObject {
  objectId?: string;
  inlineObjectProperties?: {
    embeddedObject?: {
      title?: string;
      description?: string;
      imageProperties?: { contentUri?: string };
    };
  };
}

export interface StructuralElement {
  paragraph?: Paragraph;
  table?: Table;
  sectionBreak?: object;
  tableOfContents?: object;
}

export interface Paragraph {
  elements?: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string; headingId?: string };
  bullet?: { listId?: string; nestingLevel?: number };
  /** Images anchored beside the text ("wrap text"), not inline. */
  positionedObjectIds?: string[];
}

export interface ParagraphElement {
  textRun?: { content?: string; textStyle?: TextStyle };
  footnoteReference?: { footnoteId?: string; footnoteNumber?: string };
  inlineObjectElement?: { inlineObjectId?: string };
  horizontalRule?: object;
  richLink?: { richLinkProperties?: { title?: string; uri?: string } };
  person?: { personProperties?: { name?: string; email?: string } };
  dateElement?: { dateElementProperties?: { displayText?: string } };
  equation?: object;
}

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  baselineOffset?: "NONE" | "SUPERSCRIPT" | "SUBSCRIPT" | "BASELINE_OFFSET_UNSPECIFIED";
  /** An external `url`, or a place in the doc: with includeTabsContent the API
   * fills `heading`/`bookmark`/`tabId`; the older `headingId`/`bookmarkId` otherwise. */
  link?: {
    url?: string;
    heading?: object;
    bookmark?: object;
    tabId?: string;
    headingId?: string;
    bookmarkId?: string;
  };
}

export interface Table {
  columns?: number;
  tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[];
}
