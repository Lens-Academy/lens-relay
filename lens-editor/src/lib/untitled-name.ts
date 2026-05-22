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
  if (!existing.has('Untitled.html')) return 'Untitled.html';
  for (let i = 1; ; i++) {
    const candidate = `Untitled ${i}.html`;
    if (!existing.has(candidate)) return candidate;
  }
}
