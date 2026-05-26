const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif', 'heic',
]);

export function isImageEmbedTarget(target: string): boolean {
  const path = target.split('|')[0].trim();
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot === path.length - 1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
