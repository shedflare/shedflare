// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { DriveProvider, useDrive, type DriveContextValue } from "./context";
import FileDetailPanel from "./components/FileDetailPanel";
import FileTypeStrip from "./components/FileTypeStrip";
import TagStrip from "./components/TagStrip";
import { organizationFixture } from "./test/organization-fixture";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderDrive() {
  const fixture = await organizationFixture();
  vi.stubGlobal("fetch", fixture.request);
  let context!: DriveContextValue;
  function Harness() {
    context = useDrive();
    return (
      <>
        <FileTypeStrip />
        <TagStrip />
        <FileDetailPanel />
      </>
    );
  }
  const view = render(() => (
    <DriveProvider>
      <Harness />
    </DriveProvider>
  ));
  await waitFor(() => expect(context.files().length).toBe(2));
  await waitFor(() => expect(context.tagsState().status).toBe("ready"));
  context.setSelectedFileId("report");
  return { ...view, ...fixture, context };
}

describe("Drive organization", () => {
  test("creates, persists, reuses, and removes tags from the detail picker", async () => {
    const view = await renderDrive();
    const open = () => fireEvent.click(view.getByRole("button", { name: "Add tag" }));
    open();
    let input = view.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: "  New   Tag " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Remove tag new tag" })).toBeTruthy(),
    );
    await waitFor(() => expect(view.context.tags()).toContainEqual({ name: "new tag", count: 1 }));
    expect(view.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Add tag" }));
    open();
    input = view.getByRole("combobox");
    fireEvent.input(input, { target: { value: "WORK" } });
    expect(view.queryByRole("option", { name: /Create/ })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(view.getByRole("button", { name: "Remove tag work" })).toBeTruthy());
    await waitFor(() => expect(view.context.tags()).toContainEqual({ name: "work", count: 2 }));
    await view.context.loadFiles();
    expect(view.context.selectedFile()?.tags.toSorted()).toEqual(["new tag", "work"]);
    fireEvent.click(view.getByRole("button", { name: "Remove tag new tag" }));
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Remove tag new tag" })).toBeNull(),
    );
    await waitFor(() =>
      expect(view.context.tags().some((tag) => tag.name === "new tag")).toBe(false),
    );
  });

  test("failed saves preserve the draft and saved tags for retry", async () => {
    const view = await renderDrive();
    await view.context.setFileTags(view.context.selectedFile()!, ["original"]);
    view.db.exec(
      "CREATE TRIGGER fail_tag BEFORE INSERT ON file_tags BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    fireEvent.click(view.getByRole("button", { name: "Add tag" }));
    const input = view.getByRole("combobox");
    fireEvent.input(input, { target: { value: "replacement" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Retry"));
    expect(view.context.selectedFile()?.tags).toEqual(["original"]);
    expect(input instanceof HTMLInputElement && input.value).toBe("replacement");
    view.db.exec("DROP TRIGGER fail_tag");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(view.context.selectedFile()?.tags.toSorted()).toEqual(["original", "replacement"]),
    );
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("type and tag capsules combine, toggle off, and reset pagination", async () => {
    const view = await renderDrive();
    const types = within(view.getByRole("group", { name: "File type" }));
    const tags = within(view.getByRole("group", { name: "Filter by tag" }));
    fireEvent.click(types.getByRole("button", { name: "Images" }));
    await waitFor(() => expect(view.context.files().map((file) => file.id)).toEqual(["image"]));
    fireEvent.click(tags.getByRole("button", { name: /work/ }));
    await waitFor(() => expect(view.context.filesLoading()).toBe(false));
    expect(view.context.files().map((file) => file.id)).toEqual(["image"]);
    fireEvent.click(types.getByRole("button", { name: "PDFs" }));
    await waitFor(() => expect(view.context.files()).toEqual([]));
    fireEvent.click(tags.getByRole("button", { name: /work/ }));
    await waitFor(() => expect(view.context.files().map((file) => file.id)).toEqual(["report"]));
    fireEvent.click(types.getByRole("button", { name: "PDFs" }));
    await waitFor(() => expect(view.context.files()).toHaveLength(2));
    expect(view.context.offset()).toBe(0);
    expect(types.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("a read started before saving cannot restore old tags", async () => {
    const view = await renderDrive();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let hold = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await view.request(input, init);
      if (
        new URL(input instanceof Request ? input.url : input, "http://localhost").pathname ===
          "/api/files" &&
        hold
      ) {
        hold = false;
        started?.();
        await pending;
      }
      return response;
    });
    const oldRead = view.context.loadFiles();
    await requested;
    await view.context.setFileTags(view.context.selectedFile()!, ["saved"]);
    await waitFor(() => expect(view.context.filesLoading()).toBe(false));
    release?.();
    await oldRead;
    expect(view.context.selectedFile()?.tags).toEqual(["saved"]);
  });

  test("an older filter response cannot overwrite the latest selection", async () => {
    const view = await renderDrive();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await view.request(input, init);
      if (
        new URL(input instanceof Request ? input.url : input, "http://localhost").searchParams.get(
          "type",
        ) === "images"
      ) {
        started?.();
        await pending;
      }
      return response;
    });
    view.context.setSelectedFileType("images");
    await requested;
    view.context.setSelectedFileType("pdf");
    await waitFor(() => expect(view.context.files().map((file) => file.id)).toEqual(["report"]));
    release?.();
    // Let the released response finish its JSON decode and signal updates.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.context.files().map((file) => file.id)).toEqual(["report"]);
    expect(view.context.selectedFileType()).toBe("pdf");
  });

  test("Escape closes the picker and commas cannot create broken tags", async () => {
    const view = await renderDrive();
    fireEvent.click(view.getByRole("button", { name: "Add tag" }));
    fireEvent.input(view.getByRole("combobox"), { target: { value: "one,two" } });
    expect(view.getByRole("alert").textContent).toContain("commas");
    expect(view.queryByRole("option", { name: /Create/ })).toBeNull();
    fireEvent.keyDown(view.getByRole("combobox"), { key: "Escape" });
    expect(view.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Add tag" }));
  });

  test("a count refresh failure is retryable without losing a saved tag", async () => {
    const view = await renderDrive();
    let fail = true;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      input === "/api/tags" && fail
        ? Promise.resolve(new Response("Please retry", { status: 503 }))
        : view.request(input, init),
    );
    fireEvent.click(view.getByRole("button", { name: "Add tag" }));
    fireEvent.input(view.getByRole("combobox"), { target: { value: "new" } });
    fireEvent.keyDown(view.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(view.getByRole("button", { name: "Remove tag new" })).toBeTruthy());
    await waitFor(() => expect(view.getByRole("button", { name: "Retry" })).toBeTruthy());
    fail = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.context.tags()).toContainEqual({ name: "new", count: 1 }));
    expect(view.queryByRole("alert")).toBeNull();
  });
});
