export const FILE_TYPES = [
  { value: "images", label: "Images", prefixes: ["image/"], mimeTypes: [] },
  { value: "videos", label: "Videos", prefixes: ["video/"], mimeTypes: [] },
  { value: "audio", label: "Audio", prefixes: ["audio/"], mimeTypes: [] },
  { value: "pdf", label: "PDFs", prefixes: [], mimeTypes: ["application/pdf"] },
  {
    value: "documents",
    label: "Documents",
    prefixes: [
      "text/",
      "application/vnd.openxmlformats-officedocument.",
      "application/vnd.oasis.opendocument.",
    ],
    mimeTypes: [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/rtf",
      "application/json",
      "application/xml",
    ],
  },
  {
    value: "archives",
    label: "Archives",
    prefixes: [],
    mimeTypes: [
      "application/zip",
      "application/x-zip-compressed",
      "application/x-tar",
      "application/gzip",
      "application/x-gzip",
      "application/x-7z-compressed",
      "application/vnd.rar",
      "application/x-rar-compressed",
      "application/x-bzip2",
      "application/x-xz",
    ],
  },
] as const;

export type FileTypeFilter = "" | (typeof FILE_TYPES)[number]["value"] | "other";

export function isFileTypeFilter(value: string): value is FileTypeFilter {
  return value === "" || value === "other" || FILE_TYPES.some((type) => type.value === value);
}
