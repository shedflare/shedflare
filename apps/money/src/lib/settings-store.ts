/**
 * Simple reactive settings store with localStorage caching.
 * Replaces TanStack DB settingsCollection for local read access.
 */

import { createSignal } from "solid-js";
import * as S from "effect/Schema";
import { SettingsResponseSchema, type SettingsResponse } from "../domain/schemas-client";

type SettingsMap = Record<string, string>;
type SettingsListener = () => void;

const STORAGE_KEY = "shedflare.money.settings";
const listeners = new Set<SettingsListener>();
const decodeSettings = S.decodeUnknownSync(SettingsResponseSchema);

function readStorage(): SettingsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function writeStorage(map: SettingsMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

function notifyListeners() {
  for (const listener of listeners) listener();
}

function toSettingsMap(response: SettingsResponse) {
  const map: SettingsMap = {};
  for (const setting of response.settings) {
    map[setting.key] = setting.value;
  }
  return map;
}

// Seed from localStorage so values are available instantly on page load
// without waiting for the server fetch.
const [settingsMap, setSettingsMap] = createSignal<SettingsMap>(readStorage());

export function applySettings(response: SettingsResponse) {
  const map = toSettingsMap(response);
  setSettingsMap(map);
  writeStorage(map);
  notifyListeners();
}

export function loadSettings() {
  fetch("/api/settings")
    .then((r) => r.json())
    .then((data) => {
      applySettings(decodeSettings(data));
    })
    .catch(() => {
      console.warn("[settings-store] failed to load settings");
    });
}

export function getSetting(key: string, fallback: string): string {
  return settingsMap()[key] ?? fallback;
}

export function setSetting(key: string, value: string): void {
  setSettingsMap((prev) => {
    const next = { ...prev, [key]: value };
    writeStorage(next);
    return next;
  });
  notifyListeners();
}

// Collection-like interface for compatibility (matches old TanStack DB usage)
export const settingsCollection = {
  get state() {
    return {
      values() {
        return Object.entries(settingsMap()).map(([k, v]: [string, string]) => ({
          id: k,
          key: k,
          value: v,
        }));
      },
      get(key: string) {
        return { key, value: settingsMap()[key] ?? "" };
      },
    };
  },
  get(key: string) {
    return { key, value: settingsMap()[key] ?? "" };
  },
  subscribeChanges(fn: SettingsListener) {
    listeners.add(fn);
    return { unsubscribe: () => listeners.delete(fn) };
  },
};
