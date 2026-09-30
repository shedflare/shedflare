import { eq, like, not, or, sql } from "drizzle-orm";
import { files } from "../../db/schema";
import { FILE_TYPES, type FileTypeFilter } from "../../shared/file-types";

export function fileTypeWhere(value: FileTypeFilter) {
  if (!value) return undefined;
  const mimeType = sql<string>`lower(${files.mimeType})`;
  const conditions = FILE_TYPES.map((type) => ({
    value: type.value,
    condition: or(
      ...type.prefixes.map((prefix) => like(mimeType, `${prefix}%`)),
      ...type.mimeTypes.map((mime) => eq(mimeType, mime)),
    )!,
  }));
  if (value === "other") return not(or(...conditions.map((type) => type.condition))!);
  return conditions.find((type) => type.value === value)?.condition;
}
