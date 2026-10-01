import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router } from "@solidjs/router";
import { createResource, Show } from "solid-js";
import { clearAuthHint, readAuthHint } from "@shedflare/auth-client/client";
import "./app.css";
import "./money.css";

// Lazy-load route components
import Dashboard from "./routes/index";
import BudgetPage from "./routes/budget";
import AccountsPage from "./routes/accounts";
import AccountPage from "./routes/account";
import AllTransactionsPage from "./routes/transactions";
import ReportsPage from "./routes/reports";
import SchedulesPage from "./routes/schedules";
import ScheduleDetailPage from "./routes/schedule";
import PayeesPage from "./routes/payees";
import RulesPage from "./routes/rules";
import TagsPage from "./routes/tags";
import SettingsPage from "./routes/settings";
import CategoriesPage from "./routes/categories";
import NotFound from "./routes/not-found";
import Layout from "./components/layout";

type SessionPayload = {
  user: { email: string } | null;
};

function shouldAttemptAutoLogin() {
  return new URL(window.location.href).searchParams.get("error") !== "no_session";
}

const fetchSession = async (): Promise<SessionPayload> => {
  const response = await fetch("/api/session");
  if (!response.ok) {
    if (response.status === 401) {
      // Probe contradicts the hint: drop it so it can't paint a stale shell.
      clearAuthHint();
      if (shouldAttemptAutoLogin()) {
        window.location.replace("/api/auth/login?auto=1");
      }
      return { user: null };
    }
    throw new Error("Failed to check session");
  }
  return await response.json();
};

function LoadingScreen() {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        height: "100dvh",
        gap: "1rem",
        color: "var(--text-muted)",
        background: "var(--bg-page)",
      }}
    >
      <span style={{ "font-size": "2rem" }}>💰</span>
      <p>Shedflare Money</p>
    </div>
  );
}

function LoginScreen() {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        height: "100dvh",
        gap: "1.5rem",
        color: "var(--text-muted)",
        background: "var(--bg-page)",
      }}
    >
      <span style={{ "font-size": "3rem" }}>💰</span>
      <h1 style={{ "font-size": "1.25rem", color: "var(--text-primary)", margin: 0 }}>
        Shedflare Money
      </h1>
      <a
        class="btn btn-primary"
        href="/api/auth/login"
        onClick={(e) => {
          e.preventDefault();
          window.location.assign("/api/auth/login");
        }}
        style={{ "text-decoration": "none" }}
      >
        Sign in with Google
      </a>
    </div>
  );
}

export default function App() {
  // Seed from the auth hint so a known-signed-in user paints the app shell
  // immediately. Gate on the value (not loading) so the seed short-circuits the
  // loading screen; the probe still reconciles.
  const hint = readAuthHint();
  const [session] = createResource(
    fetchSession,
    hint ? { initialValue: { user: { email: hint } } } : undefined,
  );

  return (
    <MetaProvider>
      <Title>Shedflare Money</Title>
      <Show
        when={session()?.user}
        fallback={
          <Show when={session.loading} fallback={<LoginScreen />}>
            <LoadingScreen />
          </Show>
        }
      >
        <Router root={Layout}>
          <Route path="/" component={Dashboard} />
          <Route path="/budget" component={BudgetPage} />
          <Route path="/accounts" component={AccountsPage} />
          <Route path="/accounts/:id" component={AccountPage} />
          <Route path="/transactions" component={AllTransactionsPage} />
          <Route path="/reports" component={ReportsPage} />
          <Route path="/schedules" component={SchedulesPage} />
          <Route path="/schedules/:id" component={ScheduleDetailPage} />
          <Route path="/payees" component={PayeesPage} />
          <Route path="/categories" component={CategoriesPage} />
          <Route path="/rules" component={RulesPage} />
          <Route path="/tags" component={TagsPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="*" component={NotFound} />
        </Router>
      </Show>
    </MetaProvider>
  );
}
