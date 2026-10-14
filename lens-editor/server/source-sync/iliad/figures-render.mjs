// Draw one SVG to a PNG, in a process of its own: figures.ts starts it and
// kills it when it runs too long. resvg draws inside native code, which
// nothing in the same process can interrupt.
//
// Plain JavaScript that needs only @resvg/resvg-js, so that it runs under
// `node` however the server itself was started (tsx, a test runner).
//
//   node figures-render.mjs '<options as JSON>'  < figure.svg  > figure.png
//
// Exit 0: the PNG is on stdout. Exit 2: the SVG cannot be drawn (why is on
// stderr). Exit 3: the SVG has text and this machine has no font for it.
// Killed: it used too much memory (why is on stderr), or ran too long.

import { Worker } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";

const { width, maxHeight, background, systemFonts, hasText, memoryLimitBytes, giveUpAfterMs } = JSON.parse(process.argv[2]);
const render = { background, font: { loadSystemFonts: systemFonts } };

// A watch on this process, on a thread of its own: the thread that draws
// cannot stop while it is inside resvg. It ends the process when it uses more
// than `memoryLimitBytes` (resvg's memory is native: a V8 heap limit does not
// cover it), and after `giveUpAfterMs` in case figures.ts, which kills it at
// its time limit, is no longer there (the server was restarted).
new Worker(
  `const { writeSync } = require("node:fs");
  const started = Date.now();
  setInterval(() => {
    const used = process.memoryUsage.rss();
    if (used > ${Number(memoryLimitBytes)}) writeSync(2, "it needed more than ${Math.round(Number(memoryLimitBytes) / 2 ** 20)} MB of memory");
    else if (Date.now() - started < ${Number(giveUpAfterMs)}) return;
    process.kill(process.pid, "SIGKILL");
  }, 20);`,
  { eval: true },
).unref();

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const svg = Buffer.concat(chunks).toString("utf8");

/** With no font, resvg draws text as nothing and reports no error. */
function drawsText() {
  const probe = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="2" y="15" font-size="14">Ag</text></svg>';
  return new Resvg(probe, { font: render.font }).render().pixels.some((channel) => channel !== 0);
}

try {
  if (hasText && !drawsText()) {
    process.exitCode = 3;
  } else {
    let image = new Resvg(svg, { ...render, fitTo: { mode: "width", value: width } });
    if ((image.height / image.width) * width > maxHeight) image = new Resvg(svg, { ...render, fitTo: { mode: "height", value: maxHeight } });
    process.stdout.write(image.render().asPng());
  }
} catch (err) {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
