export const MAX_FILE_TAGS = 20;

export function normalizeTag(tag: string) {
  return tag.trim().toLowerCase().replaceAll(/\s+/g, " ");
}
