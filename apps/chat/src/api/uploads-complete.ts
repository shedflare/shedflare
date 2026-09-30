import { getRuntimeEnv, requireSession, sendInternalSyncCommand } from "#/runtime";
import { AttachmentRow, decodeAttachmentRow } from "#/domain";
import { runApiTrace } from "../server/api-tracing";
import * as Schema from "effect/Schema";

async function parseUploadCompleteBody(request: Request) {
  try {
    return Schema.decodeUnknownSync(Schema.Struct({ attachment: AttachmentRow }))(
      await request.json(),
    );
  } catch {
    throw new Response("Invalid JSON", { status: 400 });
  }
}

export async function handleUploadComplete(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  return runApiTrace({
    scope: "upload-api",
    name: "upload.complete",
    kind: "io",
    env,
    attrs: {
      method: request.method,
      path: new URL(request.url).pathname,
    },
    run: async () => {
      await requireSession(request, env);
      const body = await parseUploadCompleteBody(request);
      const attachment = decodeAttachmentRow(body.attachment);
      const object = await env.UPLOADS.head(attachment.objectKey);
      if (!object) return new Response("Uploaded object not found", { status: 404 });

      await sendInternalSyncCommand(env, "complete_attachment", {
        attachment: {
          ...attachment,
          status: "ready",
          sizeBytes: object.size,
          updatedAt: new Date().toISOString(),
          optimistic: false,
          opId: attachment.opId,
        },
      });

      return Response.json({
        ok: true,
        objectKey: attachment.objectKey,
      });
    },
  });
}
