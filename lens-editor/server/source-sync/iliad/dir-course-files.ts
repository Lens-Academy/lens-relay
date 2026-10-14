/**
 * CourseFiles over a directory: a checkout of the Lens Edu content, for
 * tests and for a dry run. `root` holds what the Relay folder holds, so
 * "Lens Edu/Lenses/x.md" is `<root>/Lenses/x.md`.
 *
 * Unlike the relay, `move` rewrites no links: the sync writes every file
 * that links to a moved file itself.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sniffImage } from "../../attachments/image-types";
import type { CourseFiles } from "./types";

export function dirCourseFiles(root: string, folder = "Lens Edu"): CourseFiles {
  /** "<folder>/a/b.md" to "a/b.md"; anything else, or a path that climbs out, is an error. */
  const inFolder = (path: string): string => {
    const rest = path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : "";
    if (!rest || rest.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`"${path}" is not a file of "${folder}"`);
    return rest;
  };
  const rename_ = async (from: string, to: string) => {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  };

  return {
    async read(path) {
      try {
        return await readFile(join(root, inFolder(path)), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async write(path, content) {
      const file = join(root, inFolder(path));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },

    async move(from, to) {
      const target = join(root, inFolder(to));
      if (existsSync(target)) throw new Error(`"${to}" already exists`);
      await rename_(join(root, inFolder(from)), target);
    },

    /** To `_trash/` under the same relative path, as the relay does; a name already there gets " 2", " 3". */
    async trash(path) {
      const rest = inFolder(path);
      let target = join(root, "_trash", rest);
      for (let n = 2; existsSync(target); n++) target = join(root, "_trash", rest.replace(/(\.[^./]+)?$/, ` ${n}$1`));
      await rename_(join(root, rest), target);
    },

    /** Into `attachments/`, named by stem and content hash; resolves to that path within the folder. */
    async hostImage(bytes, stem) {
      const ext = sniffImage(bytes)?.ext ?? (/^\s*<(\?xml|svg)/.test(Buffer.from(bytes.subarray(0, 256)).toString("utf8")) ? "svg" : "bin");
      const name = `attachments/${stem}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.${ext}`;
      await mkdir(join(root, "attachments"), { recursive: true });
      await writeFile(join(root, name), bytes);
      return name;
    },
  };
}
