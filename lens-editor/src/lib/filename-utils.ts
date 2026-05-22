export function renamePreservingExtension(oldName: string, newName: string): string {
  const oldExt = extensionOf(oldName);
  const newExt = extensionOf(newName);
  if (oldExt && !newExt) return `${newName}${oldExt}`;
  return newName;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx);
}
