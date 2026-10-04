import { Facet, RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { parseSections, type Section } from '../../SectionEditor/parseSections';
import { parseFields } from '../../../lib/parseFields';
import type { SegmentTimeField } from '../../../lib/segmentTime';

/** A `from::` / `to::` line of a video segment. */
export interface VideoCutLine {
  field: SegmentTimeField;
  /** End of the line, where its button goes. */
  lineEnd: number;
  /** Start of the segment's heading: the segment's position in the file. */
  sectionFrom: number;
  /** The segment's `source::`, inherited from an earlier video segment when
   *  it has none (as the content processor does). */
  source: string;
}

/** The video segments in `text` that have a source to play, with that
 *  source. */
export function videoSegments(text: string): Array<{ section: Section; source: string }> {
  if (!/^#{1,6}\s+Video\b/m.test(text)) return [];
  const out: Array<{ section: Section; source: string }> = [];
  let lastSource: string | null = null;
  for (const section of parseSections(text)) {
    if (section.type !== 'video') continue;
    const source: string | null = parseFields(section.content).get('source')?.trim() || lastSource;
    if (!source) continue;
    lastSource = source;
    out.push({ section, source });
  }
  return out;
}

/** Every `from::` / `to::` line of the video segments in `text` that has a
 *  source to play. */
export function findVideoCutLines(text: string): VideoCutLine[] {
  const out: VideoCutLine[] = [];
  for (const { section, source } of videoSegments(text)) {
    const re = /^(from|to)::.*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(section.content))) {
      out.push({
        field: m[1] as SegmentTimeField,
        lineEnd: section.from + m.index + m[0].length,
        sectionFrom: section.from,
        source,
      });
    }
  }
  return out;
}

/** Called when a line's Tune button is clicked (or Alt-T pressed on it). */
export const videoCutCallback = Facet.define<(line: VideoCutLine, view: EditorView) => void>();

function openCutPicker(view: EditorView, line: VideoCutLine) {
  view.state.facet(videoCutCallback).forEach((cb) => cb(line, view));
}

/** Alt-T on a `from::` / `to::` line of a video segment opens its picker. */
function tuneAtCursor(view: EditorView): boolean {
  const lineEnd = view.state.doc.lineAt(view.state.selection.main.head).to;
  const line = findVideoCutLines(view.state.doc.toString()).find((l) => l.lineEnd === lineEnd);
  if (!line) return false;
  openCutPicker(view, line);
  return true;
}

class TuneButton extends WidgetType {
  constructor(private readonly line: VideoCutLine) {
    super();
  }

  eq(other: TuneButton): boolean {
    return other.line.field === this.line.field && other.line.source === this.line.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'cm-video-cut-btn';
    btn.textContent = '▶ Tune';
    btn.title = `${this.line.field === 'to' ? 'Compare nearby end times by ear' : 'Compare nearby start times by ear'} (Alt-T)`;
    btn.setAttribute('aria-label', `Tune ${this.line.field}::`);
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The widget is reused while its line moves: find the line by where
      // the button is now
      const pos = view.posAtDOM(btn);
      const now = findVideoCutLines(view.state.doc.toString()).find((l) => l.lineEnd === pos);
      if (now) openCutPicker(view, now);
    };
    return btn;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const tunePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = this.build(update.view);
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const line of findVideoCutLines(view.state.doc.toString())) {
        builder.add(line.lineEnd, line.lineEnd, Decoration.widget({ widget: new TuneButton(line), side: 1 }));
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const tuneTheme = EditorView.theme({
  '.cm-video-cut-btn': {
    marginLeft: '8px',
    padding: '0 6px',
    fontSize: '11px',
    lineHeight: '18px',
    fontFamily: 'system-ui, sans-serif',
    color: '#0f766e',
    background: '#f0fdfa',
    border: '1px solid #99f6e4',
    borderRadius: '4px',
    cursor: 'pointer',
    verticalAlign: 'middle',
  },
  '.cm-video-cut-btn:hover': { background: '#ccfbf1' },
});

/** A "▶ Tune" button after each `from::` / `to::` line of a video segment. */
export function videoCutButtons(): Extension {
  return [tunePlugin, tuneTheme, keymap.of([{ key: 'Alt-t', run: tuneAtCursor }])];
}
