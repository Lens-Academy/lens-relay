import { twinPath } from './document-resolver';

export function nextUntitledHtmlName(
  folderPath: string,
  metadata: Record<string, unknown>,
): string {
  const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
  const existing = new Set(
    Object.keys(metadata)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0])
  );
  // A name is taken by its .md/.html twin too
  const taken = (name: string) => existing.has(name) || existing.has(twinPath(name)!);
  if (!taken('Untitled.html')) return 'Untitled.html';
  for (let i = 1; ; i++) {
    const candidate = `Untitled ${i}.html`;
    if (!taken(candidate)) return candidate;
  }
}
