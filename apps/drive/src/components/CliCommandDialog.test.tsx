// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { webcrypto } from "node:crypto";
import { drizzle } from "drizzle-orm/d1";
import CliUploadCommand from "./CliUploadCommand";
import CliDownloadCommand from "./CliDownloadCommand";
import { TestDriveProvider } from "../test/test-context";
import { asD1Database, createTestD1 } from "../test/d1-shim";
import { asR2Bucket, R2Mock } from "../test/r2-mock";
import { createRouter } from "../server/router";
import { files } from "../db/schema";
import type { DriveFile } from "../types";

const file: DriveFile = {
  id: "report",
  name: "my report.txt",
  mimeType: "text/plain",
  size: 7,
  description: "",
  isPublic: false,
  tags: [],
  createdAt: "2026-09-08",
  updatedAt: "2026-09-08",
};
let requests: string[];
let copied: string;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  // jsdom lacks native dialog focus management; the browser smoke test covers it.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
  copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  const DB = asD1Database(createTestD1());
  await drizzle(DB).insert(files).values({
    id: file.id,
    name: file.name,
    objectKey: "object",
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  });
  const router = createRouter({
    DB,
    FILES: asR2Bucket(new R2Mock()),
    SECURE_UPLOAD_TOKEN_SECRET: "local-test-secret-at-least-32-characters",
    AUTH_ISSUER_URL: "https://auth.example",
    AUTH_CLIENT_ID: "drive",
    APP_PUBLIC_URL: "http://localhost",
    OWNER_EMAIL: "owner@example.com",
    DEV_AUTH_EMAIL: "owner@example.com",
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  });
  requests = [];
  // Replace only the HTTP transport: requests execute the real router, auth, crypto, and SQLite handlers.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), "http://localhost"), init);
    requests.push(new URL(request.url).pathname);
    return router.fetch(request);
  });
});

afterEach(() => {
  cleanup();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CLI transfer dialogs", () => {
  test("upload path edits update and copy the command without issuing more tokens", async () => {
    render(() => (
      <TestDriveProvider>
        <CliUploadCommand />
      </TestDriveProvider>
    ));
    fireEvent.click(screen.getByRole("button", { name: "CLI upload" }));
    const command = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "CLI command",
    });
    const copy = screen.getByRole<HTMLButtonElement>("button", { name: "Copy command" });
    expect(copy.disabled).toBe(true);
    const input = screen.getByLabelText("Local file path");
    fireEvent.input(input, { target: { value: "~/Downloads/owner's report.txt" } });
    expect(command.value).toContain('"$HOME"/');
    expect(command.value).not.toContain("<path-to-file>");
    expect(copy.disabled).toBe(false);
    fireEvent.click(copy);
    await waitFor(() => expect(copied).toBe(command.value));
    expect(requests).toEqual(["/api/secure-uploads/command"]);
    fireEvent.input(input, { target: { value: "" } });
    expect(copy.disabled).toBe(true);
  });

  test("downloads start with the filename and update the save path live", async () => {
    render(() => (
      <TestDriveProvider>
        <CliDownloadCommand file={file} />
      </TestDriveProvider>
    ));
    fireEvent.click(screen.getByRole("button", { name: "CLI download" }));
    const command = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "CLI command",
    });
    expect(command.value).toContain("'./my report.txt'");
    fireEvent.input(screen.getByLabelText("Save as path"), {
      target: { value: "/tmp/new folder/report.txt" },
    });
    expect(command.value).toContain("'/tmp/new folder/report.txt'");
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(copied).toBe(command.value));
    expect(requests).toEqual(["/api/files/report/download-command"]);
  });

  test("a failed request shows retry and preserves the entered path", async () => {
    const realTransport = globalThis.fetch;
    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection lost");
    });
    render(() => (
      <TestDriveProvider>
        <CliUploadCommand />
      </TestDriveProvider>
    ));
    fireEvent.click(screen.getByRole("button", { name: "CLI upload" }));
    fireEvent.input(screen.getByLabelText("Local file path"), {
      target: { value: "/tmp/report.txt" },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
    expect(screen.queryByText("Creating a short-lived command…")).toBeNull();
    vi.stubGlobal("fetch", realTransport);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "CLI command" })).value,
    ).toContain("'/tmp/report.txt'");
  });

  test("changing validity regenerates the command while retaining the path", async () => {
    render(() => (
      <TestDriveProvider>
        <CliUploadCommand />
      </TestDriveProvider>
    ));
    fireEvent.click(screen.getByRole("button", { name: "CLI upload" }));
    const before = (
      await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "CLI command" })
    ).value;
    fireEvent.input(screen.getByLabelText("Local file path"), {
      target: { value: "/tmp/report.txt" },
    });
    fireEvent.change(screen.getByLabelText("Valid for"), { target: { value: "600" } });
    const after = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "CLI command" });
    expect(after.value).not.toBe(before);
    expect(after.value).toContain("'/tmp/report.txt'");
    expect(requests).toHaveLength(2);
  });
});
