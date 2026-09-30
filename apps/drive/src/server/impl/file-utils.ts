export { normalizeTag } from "../../shared/tags";

export type ParsedByteRange =
  | { kind: "full" }
  | { kind: "partial"; offset: number; length: number }
  | { kind: "unsatisfiable" };

export function parseByteRange(header: string | null, size: number): ParsedByteRange {
  if (!header) return { kind: "full" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    return { kind: "unsatisfiable" };
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" };
    }
    const length = Math.min(suffixLength, size);
    return { kind: "partial", offset: size - length, length };
  }

  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(requestedEnd) ||
    offset < 0 ||
    offset >= size ||
    requestedEnd < offset
  ) {
    return { kind: "unsatisfiable" };
  }

  const end = Math.min(requestedEnd, size - 1);
  return { kind: "partial", offset, length: end - offset + 1 };
}

export interface PublicFileRow {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  description: string | null;
  isPublic: boolean | number;
  createdAt: string;
  updatedAt: string;
  tags: string | null;
}

export function publicFile(row: PublicFileRow) {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    description: row.description ?? "",
    isPublic: Boolean(row.isPublic),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
  };
}

export type UpdateFileBody = {
  name?: string;
  description?: string;
  isPublic?: boolean;
  tags?: string[];
};

const UpdateFileBodySchema = strictObject({
  name: optional(string()),
  description: optional(string()),
  isPublic: optional(boolean()),
  tags: optional(array(string())),
});

export function parseUpdateBody<Value>(value: Value): UpdateFileBody | null {
  const result = safeParse(UpdateFileBodySchema, value);
  return result.success ? result.output : null;
}
import { array, boolean, optional, safeParse, strictObject, string } from "valibot";
