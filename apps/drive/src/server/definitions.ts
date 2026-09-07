import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  DeleteResponse,
  CliDownloadCommandResponse,
  FileResponse,
  FilesResponse,
  MultipartPartResponse,
  MultipartUploadResponse,
  SecureUploadCommandResponse,
  TagsResponse,
} from "../shared/schema";

const fileListEp = HttpApiEndpoint.get("list", "/api/files", {
  success: FilesResponse,
});
const fileCreateEp = HttpApiEndpoint.post("create", "/api/files", {
  success: FileResponse,
});
const multipartCreateEp = HttpApiEndpoint.post("multipartCreate", "/api/files/multipart", {
  success: MultipartUploadResponse,
});
const multipartPartEp = HttpApiEndpoint.put(
  "multipartPart",
  "/api/files/multipart/:id/parts/:partNumber",
  {
    params: Schema.Struct({ id: Schema.String, partNumber: Schema.String }),
    success: MultipartPartResponse,
  },
);
const multipartCompleteEp = HttpApiEndpoint.post(
  "multipartComplete",
  "/api/files/multipart/:id/complete",
  {
    params: Schema.Struct({ id: Schema.String }),
    success: FileResponse,
  },
);
const multipartAbortEp = HttpApiEndpoint.delete("multipartAbort", "/api/files/multipart/:id", {
  params: Schema.Struct({ id: Schema.String }),
  success: DeleteResponse,
});
const fileUpdateEp = HttpApiEndpoint.patch("update", "/api/files/:id", {
  params: Schema.Struct({ id: Schema.String }),
  success: FileResponse,
});
const fileDeleteEp = HttpApiEndpoint.delete("delete", "/api/files/:id", {
  params: Schema.Struct({ id: Schema.String }),
  success: DeleteResponse,
});
const fileDownloadEp = HttpApiEndpoint.get("download", "/api/files/:id/download", {
  params: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
});
const filePreviewEp = HttpApiEndpoint.get("preview", "/api/files/:id/preview", {
  params: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
});
const fileDownloadCommandEp = HttpApiEndpoint.post(
  "downloadCommand",
  "/api/files/:id/download-command",
  {
    params: Schema.Struct({ id: Schema.String }),
    success: CliDownloadCommandResponse,
  },
);

const filesGroup = HttpApiGroup.make("files").add(
  fileListEp,
  fileCreateEp,
  multipartCreateEp,
  multipartPartEp,
  multipartCompleteEp,
  multipartAbortEp,
  fileUpdateEp,
  fileDeleteEp,
  fileDownloadEp,
  fileDownloadCommandEp,
  filePreviewEp,
);

const tagListEp = HttpApiEndpoint.get("list", "/api/tags", {
  success: TagsResponse,
});

const tagsGroup = HttpApiGroup.make("tags").add(tagListEp);

const secureUploadCommandEp = HttpApiEndpoint.post("createCommand", "/api/secure-uploads/command", {
  success: SecureUploadCommandResponse,
});

const secureUploadsGroup = HttpApiGroup.make("secureUploads").add(secureUploadCommandEp);

export const driveApi = HttpApi.make("drive").add(filesGroup, tagsGroup, secureUploadsGroup);
