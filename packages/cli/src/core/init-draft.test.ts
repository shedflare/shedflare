import { expect, test } from "vite-plus/test";
import { createDraft, validateDraft, createPlan } from "./init-draft.js";
import { APP_IDS, getAllManifests } from "./manifests.js";
import type { InitDraft } from "./init-draft.js";

const manifests = Object.fromEntries(getAllManifests().map((manifest) => [manifest.id, manifest]));

test("createDraft defaults to all apps", () => {
  const draft = createDraft({});
  expect(draft.apps).toEqual([...APP_IDS]);
  expect(draft.mockResources).toBe(false);
});

test("createDraft parses comma-separated apps", () => {
  const draft = createDraft({ apps: "auth,chat" });
  expect(draft.apps).toEqual(["auth", "chat"]);
});

test("createDraft throws on unknown app IDs", () => {
  expect(() => createDraft({ apps: "auth,unknown,chat" })).toThrow("Unknown app");
  expect(() => createDraft({ apps: "unknown" })).toThrow("Unknown app");
});

test("createDraft sets mockResources from options", () => {
  const draft = createDraft({ mockResources: true });
  expect(draft.mockResources).toBe(true);
});

test("validateDraft passes with valid draft", () => {
  const draft: InitDraft = {
    apps: ["auth", "chat"],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const result = validateDraft(draft);
  expect(result.valid).toBe(true);
});

test("validateDraft fails without ownerEmail", () => {
  const draft: InitDraft = {
    apps: ["auth"],
    ownerEmail: "",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const result = validateDraft(draft);
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.errors).toContain("Owner email is required");
  }
});

test("validateDraft fails without domain", () => {
  const draft: InitDraft = {
    apps: ["auth"],
    ownerEmail: "me@example.com",
    domain: "",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const result = validateDraft(draft);
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.errors).toContain("Domain is required");
  }
});

test("validateDraft fails with no apps", () => {
  const draft: InitDraft = {
    apps: [],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const result = validateDraft(draft);
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.errors).toContain("At least one app must be selected");
  }
});

test("createPlan resolves URLs before vars regardless of input order", () => {
  // chat depends on auth, but we list chat first
  const draft: InitDraft = {
    apps: ["chat", "auth"],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const plan = createPlan(draft, manifests);

  // URLs should exist for both apps
  expect(plan.urls.auth).toBe("https://auth.example.com");
  expect(plan.urls.chat).toBe("https://chat.example.com");

  // chat's AUTH_URL should resolve to auth's URL
  expect(plan.resolvedVars.chat?.AUTH_URL).toBe("https://auth.example.com");
});

test("createPlan sets deploy order with auth first", () => {
  const draft: InitDraft = {
    apps: ["chat", "drive", "auth"],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const plan = createPlan(draft, manifests);
  expect(plan.deployOrder).toEqual(["auth", "chat", "drive"]);
});

test("createPlan resolves all var sources", () => {
  const draft: InitDraft = {
    apps: ["auth", "chat"],
    ownerEmail: "owner@test.com",
    domain: "test.com",
    subdomains: {},
    vars: { chat: { DEFAULT_MODEL_ID: "claude-3" } },
    secrets: {},
    mockResources: true,
  };
  const plan = createPlan(draft, manifests);

  // url type
  expect(plan.resolvedVars.auth?.APP_PUBLIC_URL).toBe("https://auth.test.com");
  // appUrl type
  expect(plan.resolvedVars.chat?.AUTH_URL).toBe("https://auth.test.com");
  // appId type
  expect(plan.resolvedVars.chat?.AUTH_CLIENT_ID).toBe("shedflare-chat");
  // ownerEmail type
  expect(plan.resolvedVars.auth?.OWNER_EMAIL).toBe("owner@test.com");
  // user type with drafted value
  expect(plan.resolvedVars.chat?.DEFAULT_MODEL_ID).toBe("claude-3");
});

test("createPlan uses custom subdomains", () => {
  const draft: InitDraft = {
    apps: ["auth", "chat"],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: { auth: "login", chat: "talk" },
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const plan = createPlan(draft, manifests);
  expect(plan.urls.auth).toBe("https://login.example.com");
  expect(plan.urls.chat).toBe("https://talk.example.com");
});

test("createPlan respects user var defaults when not provided", () => {
  const draft: InitDraft = {
    apps: ["auth", "chat"],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: {},
    mockResources: true,
  };
  const plan = createPlan(draft, manifests);
  expect(plan.resolvedVars.chat?.DEFAULT_MODEL_ID).toBe("auto");
});

test("createPlan resolves secrets from draft", () => {
  const draft: InitDraft = {
    apps: ["auth", "chat"],
    ownerEmail: "me@example.com",
    domain: "example.com",
    subdomains: {},
    vars: {},
    secrets: { chat: { OPENCODE_GO_API_KEY: "key-123", UPLOAD_TOKEN_SECRET: "token-456" } },
    mockResources: true,
  };
  const plan = createPlan(draft, manifests);
  expect(plan.resolvedSecrets.chat?.OPENCODE_GO_API_KEY).toBe("key-123");
  expect(plan.resolvedSecrets.chat?.UPLOAD_TOKEN_SECRET).toBe("token-456");
});
