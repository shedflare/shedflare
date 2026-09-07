import { Show } from "solid-js";
import { useDrive, fileGlyph, formatSize } from "../context";
import CliDownloadCommand from "./CliDownloadCommand";

export default function FileDetailPanel() {
  const ctx = useDrive();
  const file = () => ctx.selectedFile();
  const previewUrl = () => (file() ? `/api/files/${file()!.id}/preview` : "");

  return (
    <Show when={file()}>
      {(f) => (
        <div class="file-detail">
          <div class="detail-preview">
            <Show when={f().mimeType.startsWith("image/")}>
              <img src={previewUrl()} alt={f().name} />
            </Show>
            <Show when={f().mimeType.startsWith("video/")}>
              <video src={previewUrl()} controls playsinline preload="metadata" />
            </Show>
            <Show when={f().mimeType.startsWith("audio/")}>
              <audio src={previewUrl()} controls preload="metadata" class="detail-audio" />
            </Show>
            <Show
              when={
                !f().mimeType.startsWith("image/") &&
                !f().mimeType.startsWith("video/") &&
                !f().mimeType.startsWith("audio/")
              }
            >
              <div class={`file-mark file-mark-lg ${fileGlyph(f()).toLowerCase()}`}>
                {fileGlyph(f())}
              </div>
            </Show>
          </div>

          <div class="detail-body">
            <h2 class="detail-name">{f().name}</h2>

            <div class="share-state" classList={{ public: f().isPublic }}>
              <span class="share-dot" />
              <span>{f().isPublic ? "Publicly shared" : "Private"}</span>
            </div>

            <Show when={f().description}>
              <p class="detail-description">{f().description}</p>
            </Show>

            <dl class="detail-meta">
              <div>
                <dt>Type</dt>
                <dd>{f().mimeType}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatSize(f().size)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{new Date(f().createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Modified</dt>
                <dd>{new Date(f().updatedAt).toLocaleString()}</dd>
              </div>
            </dl>

            <div class="detail-tags">
              <span class="detail-tags-label">Tags</span>
              <Show when={f().tags.length > 0} fallback={<span class="no-tags">No tags</span>}>
                <div class="detail-tags-list">
                  {f().tags.map((tag) => (
                    <span class="detail-tag">{tag}</span>
                  ))}
                </div>
              </Show>
            </div>

            <div class="detail-actions">
              <button class="btn btn-primary" onClick={() => ctx.download(f())}>
                Download
              </button>
              <CliDownloadCommand file={f()} />
              <Show
                when={f().isPublic}
                fallback={
                  <button class="btn" onClick={() => void ctx.setFilePublic(f(), true)}>
                    Make public
                  </button>
                }
              >
                <button class="btn" onClick={() => void ctx.copyPublicLink(f())}>
                  Copy public link
                </button>
                <button class="btn" onClick={() => void ctx.setFilePublic(f(), false)}>
                  Make private
                </button>
              </Show>
              <button class="btn" onClick={() => ctx.setEditingId(f().id)}>
                Rename
              </button>
              <button class="btn btn-danger" onClick={() => ctx.setPendingDeleteId(f().id)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
