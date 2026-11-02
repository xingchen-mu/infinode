// Shared by the page and the server: board thumbnails.

/** Long side of a thumbnail, in pixels: items shown smaller than this on screen use it. */
export const THUMB_PX = 768;

/** The thumbnail of a media URL (/files/<file> → /files/thumb/<file>); other URLs are returned as they are. */
export function thumbUrl(url: string): string {
  return url.replace(/^\/files\//, '/files/thumb/');
}
