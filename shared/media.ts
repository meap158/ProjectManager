export const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
};
export function mediaKind(name: string): 'video' | 'audio' | null {
  const type = MEDIA_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()];
  return type?.startsWith('video/') ? 'video' : type ? 'audio' : null;
}
