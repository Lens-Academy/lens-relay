/**
 * Timeout-safe fetch. Motivated by a production hang: a Jina render fetch with
 * a bare `AbortSignal.timeout(60s)` never aborted and held its socket open for
 * hours. Undici registers abort listeners on the signal via a weak reference
 * (per the WHATWG leak-avoidance change), so a timeout signal that nothing else
 * references can be garbage-collected before its timer fires — and the request
 * then has no deadline at all.
 *
 * This helper keeps a strong reference to its own AbortController and timer for
 * the whole request, and the timeout covers the BODY READ too (a `signal` on
 * `fetch()` alone stops guarding once the caller starts consuming the body
 * outside the helper). All import-pipeline HTTP — raw page fetches, the Jina
 * render tier, relay API calls, PDF-parser providers — should go through here.
 */

export interface FetchBytesOptions {
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  // Uint8Array is listed explicitly: TS 5.7's generic Uint8Array<ArrayBufferLike>
  // no longer satisfies the DOM BodyInit union, but undici accepts it fine.
  body?: BodyInit | Uint8Array;
  /** Outer signal (e.g. a per-job deadline / cancel) that also aborts this call. */
  signal?: AbortSignal;
  /** Abort as soon as the response body exceeds this many bytes. Without it
   *  the whole body buffers before any caller-side size check — a hostile fast
   *  server could push gigabytes inside the timeout window. */
  maxBytes?: number;
}

export interface FetchBytesResult {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Headers;
  bytes: ArrayBuffer;
}

/** The full response body decoded as UTF-8 — convenience for error messages/JSON. */
export function bytesToText(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export async function fetchBytesWithTimeout(
  url: string,
  opts: FetchBytesOptions,
): Promise<FetchBytesResult> {
  const { timeoutMs, signal: outer, maxBytes, ...init } = opts;
  if (outer?.aborted) {
    throw outer.reason instanceof Error
      ? outer.reason
      : new Error(String(outer.reason ?? "Request aborted"));
  }

  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(outer?.reason);
  const timer = setTimeout(
    () => ctrl.abort(new Error(`Request timed out after ${timeoutMs}ms: ${url}`)),
    timeoutMs,
  );
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const resp = await fetch(url, {
      ...init,
      body: init.body as BodyInit | undefined,
      // Redirects are always handled by callers (SSRF re-validation per hop).
      redirect: "manual",
      signal: ctrl.signal,
    });
    // Read the body while the timer is still armed — a server that returns
    // headers then trickles the body must not stall us forever. With maxBytes,
    // stream and bail the moment the cap is crossed (declared or actual size).
    let bytes: ArrayBuffer;
    if (maxBytes !== undefined) {
      const declared = Number(resp.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        ctrl.abort(new Error(`Response too large: ${declared} bytes (max ${maxBytes})`));
        throw ctrl.signal.reason;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (resp.body) {
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            ctrl.abort(new Error(`Response too large: >${maxBytes} bytes`));
            throw ctrl.signal.reason;
          }
          chunks.push(value);
        }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      bytes = merged.buffer;
    } else {
      bytes = await resp.arrayBuffer();
    }
    return {
      status: resp.status,
      ok: resp.ok,
      statusText: resp.statusText,
      headers: resp.headers,
      bytes,
    };
  } catch (err) {
    // Surface the abort *reason* (our descriptive timeout / job-cancel error)
    // instead of undici's generic "This operation was aborted".
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) {
      throw ctrl.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
