/**
 * Fetches ELK (the `elkjs` package, 1.5 MB) the first time the concept map
 * is drawn with it. The only file that imports the package, so everything
 * else builds and is tested without it.
 */
import type { ElkLike } from './idea-map-elk';

let loading: Promise<ElkLike> | null = null;

/** ELK itself, fetched once; a failed fetch is tried again the next time. */
export function loadElk(): Promise<ElkLike> {
  loading ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK());
  loading.catch(() => { loading = null; });
  return loading;
}
