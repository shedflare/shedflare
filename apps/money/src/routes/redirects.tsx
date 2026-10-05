import { Navigate, useLocation, useParams } from "@solidjs/router";

/** Older feature routes now live inside Overview and Plan; keep bookmarks and links working. */
function forward(path: string, rename: Record<string, string> = {}) {
  return function Redirect() {
    const location = useLocation();
    const params = new URLSearchParams(location.search);
    for (const [from, to] of Object.entries(rename)) {
      const value = params.get(from);
      params.delete(from);
      if (value !== null) params.set(to, value);
    }
    const query = params.toString();
    return <Navigate href={query ? `${path}?${query}` : path} />;
  };
}

export const BudgetRedirect = forward("/plan");
export const TransactionsRedirect = forward("/");
export const SchedulesRedirect = forward("/plan", { focus: "payment" });

export function ScheduleRedirect() {
  const params = useParams<{ id: string }>();
  return <Navigate href={`/plan?payment=${encodeURIComponent(params.id)}`} />;
}
