import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:bridge-bundle';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const __dirname = dirname(fileURLToPath(import.meta.url));

export function bridgeBundlePlugin(): Plugin {
  return {
    name: 'lens-bridge-bundle',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;

      const entry = resolve(__dirname, 'src/components/HtmlEditor/bridge/bridge-script.ts');
      const result = await build({
        metafile: true,
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        globalName: 'LensBridge',
        platform: 'browser',
        target: 'es2022',
        write: false,
        minify: false,
      });
      // Watch every module in the bundle, not just the entry, so editing an
      // imported file (e.g. page-services.ts) rebuilds the bridge in dev.
      for (const input of Object.keys(result.metafile.inputs)) {
        // Metafile paths are relative to esbuild's working dir (process.cwd()).
        this.addWatchFile(resolve(process.cwd(), input));
      }
      const bundled = result.outputFiles[0].text;
      const finalSource = `${bundled}\n;LensBridge.installBridge(window);\n`;
      return `export const BRIDGE_SOURCE = ${JSON.stringify(finalSource)};\n`;
    },
  };
}
