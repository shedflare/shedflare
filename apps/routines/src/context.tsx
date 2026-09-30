import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  useContext,
  Match,
  Switch,
  type JSX,
} from "solid-js";
import { clearAuthHint, readAuthHint } from "@shedflare/auth-client/client";
import { parse } from "valibot";
import {
  CompletionsResponseSchema,
  CreatedResponseSchema,
  DayResponseSchema,
  SessionResponseSchema,
  type Routine,
  type RoutineCompletion,
} from "./types";

function shouldAttemptAutoLogin() {
  return new URL(window.location.href).searchParams.get("error") !== "no_session";
}

/**
 * Sends an unauthenticated user to sign in without looping. After silent auth
 * has already bounced back with `?error=no_session`, retrying it would loop
 * (gate → issuer → no_session → gate), so fall back to interactive login.
 */
function redirectToLogin() {
  clearAuthHint();
  window.location.replace(shouldAttemptAutoLogin() ? "/api/auth/login?auto=1" : "/api/auth/login");
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface RoutineInput {
  name: string;
  durationMinutes: number;
  color: string;
  weeklyTarget: number;
}

interface RoutinesContextValue {
  userEmail: () => string;
  loading: () => boolean;

  selectedDate: () => string;
  setSelectedDate: (date: string) => void;

  routines: () => Routine[];
  /** All completed completions for the selected date's month. */
  monthCompletions: () => RoutineCompletion[];
  /** Completions for the selected date only (derived from monthCompletions). */
  completions: () => RoutineCompletion[];
  /** Completed count this week (Sun–Sat of the selected date) per routine id. */
  weekCounts: () => Record<string, number>;
  sleepTime: () => string;
  /** Bumps on any mutation so views (calendar, analytics) can re-fetch ranges. */
  revision: () => number;

  addRoutine: (input: RoutineInput) => Promise<void>;
  updateRoutine: (id: string, input: RoutineInput) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  toggleCompletion: (routineId: string) => Promise<void>;
  updateSleepTime: (sleepTime: string) => Promise<void>;
  /** Completed completions across an inclusive [from, to] range. */
  fetchCompletions: (from: string, to: string) => Promise<RoutineCompletion[]>;
}

const RoutinesContext = createContext<RoutinesContextValue>();

export function RoutinesProvider(props: { children: JSX.Element }) {
  // Seed from the auth hint so a known-signed-in user paints the app shell
  // immediately instead of the loading state. bootstrap() reconciles below.
  const sessionHint = readAuthHint();
  const [userEmail, setUserEmail] = createSignal(sessionHint);
  const [sessionState, setSessionState] = createSignal<
    "checking" | "authenticated" | "signed-out" | "unavailable"
  >(sessionHint ? "authenticated" : "checking");
  const loading = () => sessionState() === "checking";
  const [selectedDate, setSelectedDate] = createSignal(toDateStr(new Date()));

  const [routines, setRoutines] = createSignal<Routine[]>([]);
  const [monthCompletions, setMonthCompletions] = createSignal<RoutineCompletion[]>([]);
  const [sleepTime, setSleepTime] = createSignal("22:00");
  const [revision, setRevision] = createSignal(0);

  /** Completions for the selected date, derived from the month-level data. */
  const completions = createMemo(() => {
    const date = selectedDate();
    return monthCompletions().filter((c) => c.date === date);
  });

  /** Completed count per routine for the Sun–Sat week of the selected date. */
  const weekCounts = createMemo(() => {
    const [y, m, d] = selectedDate().split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    const weekStart = new Date(y, m - 1, d - dow);
    const fmt = (dt: Date) =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const start = fmt(weekStart);
    const end = fmt(new Date(weekStart.getTime() + 6 * 86_400_000));
    const counts: Record<string, number> = {};
    for (const c of monthCompletions()) {
      if (c.completed && c.date >= start && c.date <= end) {
        counts[c.routineId] = (counts[c.routineId] ?? 0) + 1;
      }
    }
    return counts;
  });

  async function loadDay(date: string) {
    const [y, m] = date.split("-").map(Number);
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const monthEnd = new Date(y, m, 0);
    const monthEndStr = `${y}-${String(m).padStart(2, "0")}-${String(monthEnd.getDate()).padStart(2, "0")}`;

    const [dayResp, compsResp] = await Promise.all([
      fetch(`/api/routines/day?date=${date}`),
      fetch(`/api/routines/completions?from=${monthStart}&to=${monthEndStr}`),
    ]);

    if (dayResp.status === 401 || dayResp.status === 403) {
      redirectToLogin();
      return;
    }
    if (!dayResp.ok) return;

    const data = parse(DayResponseSchema, await dayResp.json());
    setRoutines(data.routines);
    setSleepTime(data.sleepTime);

    if (compsResp.ok) {
      const comps = parse(CompletionsResponseSchema, await compsResp.json());
      setMonthCompletions(comps.completions);
    }
  }

  async function fetchCompletions(from: string, to: string): Promise<RoutineCompletion[]> {
    const resp = await fetch(`/api/routines/completions?from=${from}&to=${to}`);
    if (!resp.ok) return [];
    const data = parse(CompletionsResponseSchema, await resp.json());
    return data.completions;
  }

  async function bootstrap() {
    setSessionState("checking");
    try {
      const session = await fetch("/api/session");
      if (session.status === 401) {
        setUserEmail("");
        clearAuthHint();
        setSessionState("signed-out");
        if (shouldAttemptAutoLogin()) window.location.replace("/api/auth/login?auto=1");
        return;
      }
      if (!session.ok) {
        setSessionState("unavailable");
        return;
      }
      const user = parse(SessionResponseSchema, await session.json());
      setUserEmail(user.user.email);
      await loadDay(selectedDate());
      setSessionState("authenticated");
    } catch {
      setSessionState("unavailable");
    }
  }

  let lastLoadedMonth = "";

  createEffect(() => {
    const date = selectedDate();
    if (!userEmail()) return;
    const monthKey = date.slice(0, 7);
    if (monthKey !== lastLoadedMonth) {
      lastLoadedMonth = monthKey;
      void loadDay(date);
    }
  });

  const bump = () => setRevision((r) => r + 1);

  const rollback = () => {
    lastLoadedMonth = "";
    void loadDay(selectedDate());
  };

  const addRoutine = async (input: RoutineInput) => {
    const tempId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Routine = {
      id: tempId,
      name: input.name,
      color: input.color,
      durationMinutes: input.durationMinutes,
      weeklyTarget: input.weeklyTarget,
      sortOrder: routines().length,
      createdAt: now,
      updatedAt: now,
    };
    setRoutines((prev) => [...prev, optimistic]);
    bump();

    const resp = await fetch("/api/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (resp.ok) {
      const data = parse(CreatedResponseSchema, await resp.json());
      setRoutines((prev) => prev.map((r) => (r.id === tempId ? { ...r, id: data.id } : r)));
    } else {
      rollback();
    }
  };

  const updateRoutine = async (id: string, input: RoutineInput) => {
    const prev = routines();
    setRoutines((r) =>
      r.map((r) =>
        r.id === id
          ? {
              ...r,
              name: input.name,
              color: input.color,
              durationMinutes: input.durationMinutes,
              weeklyTarget: input.weeklyTarget,
              updatedAt: new Date().toISOString(),
            }
          : r,
      ),
    );
    bump();

    const resp = await fetch(`/api/routines/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      setRoutines(prev);
      rollback();
    }
  };

  const deleteRoutine = async (id: string) => {
    const prevRoutines = routines();
    const prevMonthCompletions = monthCompletions();
    setRoutines((r) => r.filter((r) => r.id !== id));
    setMonthCompletions((c) => c.filter((c) => c.routineId !== id));
    bump();

    const resp = await fetch(`/api/routines/${id}`, { method: "DELETE" });
    if (!resp.ok) {
      setRoutines(prevRoutines);
      setMonthCompletions(prevMonthCompletions);
      rollback();
    }
  };

  const toggleCompletion = async (routineId: string) => {
    const date = selectedDate();
    const existing = monthCompletions().find((c) => c.routineId === routineId && c.date === date);
    const now = new Date().toISOString();

    // Optimistically flip completion in month-level data.
    // completions and weekCounts are derived memos that recompute automatically.
    if (existing) {
      const newCompleted = !existing.completed;
      setMonthCompletions((c) =>
        c.map((c) =>
          c.id === existing.id ? { ...c, completed: newCompleted, updatedAt: now } : c,
        ),
      );
    } else {
      const tempId = crypto.randomUUID();
      setMonthCompletions((c) => [
        ...c,
        {
          id: tempId,
          routineId,
          date,
          completed: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    bump();

    const resp = await fetch("/api/routines/completion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routineId, date }),
    });
    if (!resp.ok) rollback();
  };

  const updateSleepTime = async (value: string) => {
    const prev = sleepTime();
    setSleepTime(value);

    const resp = await fetch("/api/routines/settings/sleep-time", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sleepTime: value }),
    });
    if (!resp.ok) setSleepTime(prev);
  };

  void bootstrap();

  return (
    <RoutinesContext.Provider
      value={{
        userEmail,
        loading,
        selectedDate,
        setSelectedDate,
        routines,
        monthCompletions,
        completions,
        weekCounts,
        sleepTime,
        revision,
        addRoutine,
        updateRoutine,
        deleteRoutine,
        toggleCompletion,
        updateSleepTime,
        fetchCompletions,
      }}
    >
      <Switch fallback={props.children}>
        <Match when={sessionState() === "signed-out"}>
          <div class="loading">
            <a href="/api/auth/login">Sign in with Google</a>
          </div>
        </Match>
        <Match when={sessionState() === "unavailable"}>
          <div class="loading" role="alert">
            <p>Could not check your session.</p>
            <button class="btn" onClick={() => void bootstrap()}>
              Try again
            </button>
          </div>
        </Match>
      </Switch>
    </RoutinesContext.Provider>
  );
}

export function useRoutines() {
  const ctx = useContext(RoutinesContext);
  if (!ctx) throw new Error("useRoutines must be used within RoutinesProvider");
  return ctx;
}
