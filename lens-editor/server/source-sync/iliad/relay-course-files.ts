/**
 * CourseFiles over the relay's server-token HTTP API: the same authenticated
 * path the article sync writes through (../relay-files.ts), plus the two
 * calls a course needs that an article does not, move and trash. Never
 * storage directly: the relay holds every open document in memory.
 */

import { getRelayConfig } from "../../add-video/relay-docs";
import { bytesToText, fetchBytesWithTimeout } from "../../fetch-timeout";
import { hostRelayImage, relayFiles } from "../relay-files";
import type { CourseFiles } from "./types";

const RELAY_TIMEOUT_MS = 60_000;

/** One POST to the relay with the server token. */
async function post(route: string, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const { url, token } = getRelayConfig();
  const resp = await fetchBytesWithTimeout(`${url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    timeoutMs: RELAY_TIMEOUT_MS,
  });
  return { ok: resp.ok, status: resp.status, text: bytesToText(resp.bytes) };
}

export interface RelayCourseFilesOptions {
  /** The Relay folder images are hosted in. */
  folder?: string;
  /**
   * The relay refuses to trash a file that another file links to, and it
   * learns a second or two late that a module stopped linking to a lens. So
   * a refused trash is tried again: this many times in all, this far apart.
   */
  trashAttempts?: number;
  trashRetryMs?: number;
}

export function relayCourseFiles({ folder = "Lens Edu", trashAttempts = 4, trashRetryMs = 3_000 }: RelayCourseFilesOptions = {}): CourseFiles {
  const files = relayFiles();
  const folderOf = (path: string) => path.slice(0, path.indexOf("/"));

  return {
    read: files.read,
    write: files.write,

    /**
     * POST /move, the call behind a rename in the editor: the file keeps its
     * id and history, and the relay rewrites the links in it and to it. The
     * relay answers 409 when the target exists.
     */
    async move(from, to) {
      const top = folderOf(from);
      if (!top || folderOf(to) !== top) throw new Error(`Relay: cannot move "${from}" to "${to}": not in one folder`);
      const resp = await post("/move", { path: from, new_path: to.slice(top.length) });
      if (resp.status === 409) throw new Error(`Relay: cannot move "${from}": "${to}" already exists`);
      if (!resp.ok) throw new Error(`Relay: moving "${from}" to "${to}" failed: ${resp.status} ${resp.text}`);
    },

    /** POST /doc/trash: to the folder's `_trash/`, restorable until the relay's retention period ends. Never forced. */
    async trash(path) {
      for (let attempt = 1; ; attempt++) {
        const resp = await post("/doc/trash", { path });
        if (resp.ok) return;
        let refusal: { code?: string; referencing?: { path: string }[] } = {};
        try {
          refusal = JSON.parse(resp.text) as typeof refusal;
        } catch {
          /* not the relay's JSON error body */
        }
        if (resp.status !== 409 || refusal.code !== "inbound_links") throw new Error(`Relay: trashing "${path}" failed: ${resp.status} ${resp.text}`);
        if (attempt >= trashAttempts) {
          throw new Error(`Relay: "${path}" was not trashed, because these still link to it: ${(refusal.referencing ?? []).map((ref) => ref.path).join(", ")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, trashRetryMs));
      }
    },

    /** The article sync's image path: checked, stored once per content, named by stem and hash. */
    hostImage: (bytes, stem) => hostRelayImage(folder, stem, bytes),
  };
}
