// Shared by the page and the server: board thumbnails.

/** Long side of a thumbnail, in pixels: items shown smaller than this on screen use it. */
export const THUMB_PX = 768;

/** The thumbnail of a media URL (/files/<file> → /files/thumb/<file>); other URLs are returned as they are. */
export function thumbUrl(url: string): string {
  return url.replace(/^\/files\//, '/files/thumb/');
}

/** File sizes as people read them: 812 MB, 20.4 GB. */
export function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
