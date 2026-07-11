import { test, expect } from '@playwright/test';

const cases = [
  { name: 'rendered bullet', text: '- rendered bullet text '.repeat(8), cursor: 999, marker: '.cm-bullet', content: 2 },
  { name: 'raw bullet', text: '- raw bullet text '.repeat(8), cursor: 1, marker: '.cm-list-raw-marker', content: 2 },
  { name: 'ordered multi-digit', text: '12. ordered text '.repeat(8), cursor: 999, marker: '.cm-list-raw-marker', content: 4 },
  { name: 'rendered task', text: '- [ ] rendered task text '.repeat(8), cursor: 999, marker: '.cm-task-marker', content: 6 },
  { name: 'editing task', text: '- [ ] editing task text '.repeat(8), cursor: 3, marker: '.cm-list-raw-marker', content: 6 },
  { name: 'editing ordered task', text: '12. [ ] ordered task text '.repeat(8), cursor: 6, marker: '.cm-list-raw-marker', content: 8 },
  { name: 'editing long ordered task', text: '123456789. [ ] legal task text '.repeat(8), cursor: 13, marker: '.cm-list-raw-marker', content: 15 },
  { name: 'nested bullet', text: '- parent\n\t- nested text '.repeat(8), cursor: 999, marker: '.cm-bullet', content: 3, line: 1 },
  { name: 'depth-two bullet', text: '- parent\n\t- child\n\t\t- deep text '.repeat(8), cursor: 999, marker: '.cm-bullet', content: 4, line: 2 },
  { name: 'nested task', text: '- parent\n\t- [ ] nested task text '.repeat(8), cursor: 999, marker: '.cm-task-marker', content: 7, line: 1 },
  { name: 'nested ordered', text: '1. parent\n\t12. nested ordered text '.repeat(8), cursor: 999, marker: '.cm-list-raw-marker', content: 5, line: 1 },
];

test('real livePreview list geometry preserves inset and hanging alignment', async ({ page }) => {
  await page.goto('https://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ path: 'src/index.css' });
  const measurements = await page.evaluate(async (definitions) => {
    const [{ EditorState }, { EditorView }, { markdown }, { TaskList }, { livePreview }] = await Promise.all([
      import('/@id/@codemirror/state'),
      import('/@id/@codemirror/view'),
      import('/@id/@codemirror/lang-markdown'),
      import('/@id/@lezer/markdown'),
      import('/src/components/Editor/extensions/livePreview.ts'),
    ]);
    return definitions.map(def => {
      const host = document.body.appendChild(document.createElement('div'));
      host.style.width = '190px';
      const view = new EditorView({ parent: host, state: EditorState.create({
        doc: def.text,
        selection: { anchor: Math.min(def.cursor, def.text.length) },
        extensions: [markdown({ extensions: [TaskList] }), livePreview(), EditorView.lineWrapping],
      }) });
      const lines = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-list-line')];
      const line = lines[def.line ?? 0];
      const marker = line.querySelector<HTMLElement>(def.marker)!;
      if (!marker) throw new Error(`${def.name}: missing ${def.marker}; ${line?.innerHTML}`);
      const lineRect = line.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      const from = view.state.doc.line((def.line ?? 0) + 1).from + def.content;
      const first = view.coordsAtPos(from)!;
      let continuation: DOMRect | null = null;
      for (let pos = from + 1; pos <= view.state.doc.lineAt(from).to; pos++) {
        const rect = view.coordsAtPos(pos);
        if (rect && rect.top > first.top + 1) { continuation = rect; break; }
      }
      view.destroy(); host.remove();
      return { name: def.name, lineX: lineRect.x, markerX: markerRect.x,
        markerRight: markerRect.right, firstX: first.left, continuationX: continuation?.left };
    });
  }, cases);
  for (const m of measurements) {
    if (m.name.includes('nested') || m.name.includes('depth-two')) expect(m.markerX).toBeGreaterThan(m.lineX + 6);
    else expect(m.markerX, `${m.name} inset`).toBeCloseTo(m.lineX + 6, 0);
    expect(m.firstX, `${m.name} first text`).toBeCloseTo(m.markerRight, 0);
    if (m.continuationX !== undefined)
      expect(m.continuationX, `${m.name} continuation`).toBeCloseTo(m.markerRight, 0);
    if (m.name.includes('ordered task')) expect(m.continuationX, `${m.name} wraps`).toBeDefined();
  }
});
