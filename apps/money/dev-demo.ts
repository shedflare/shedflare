import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createMoneyTestEnv, dbFor } from "./src/test/helpers";
import { handleCommand } from "./src/server/command-handlers/handle-command";
import { createRouter } from "./src/server/router";
import { formatCalendarDate, toMonthInt } from "./src/domain/types";
import type { CommandInvocation } from "./src/domain/commands";
import type { CategoryIcon } from "./src/domain/category-icons";

const demoCurrency = process.env.MONEY_DEMO_CURRENCY === "IDR" ? "IDR" : "USD";
const demoScale = demoCurrency === "IDR" ? 10_000 : 1;
const env = createMoneyTestEnv();
const db = dbFor(env);
async function command(invocation: CommandInvocation) {
  const result = await handleCommand(db, invocation);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function requireId(result: { id?: string }): string {
  if (!result.id) throw new Error("Demo record was not created");
  return result.id;
}
await command({
  commandType: "update_setting",
  payload: { key: "display_currency", value: demoCurrency },
});
const now = new Date();
const date = formatCalendarDate(now);
const month = date.slice(0, 7);
const accountId = requireId(
  await command({ commandType: "create_account", payload: { name: "Everyday" } }),
);
await command({
  commandType: "create_account",
  payload: { name: "Savings", balance: 420_000 * demoScale, offBudget: true },
});
const incomeId = requireId(
  await command({
    commandType: "create_category",
    payload: { name: "Income", groupId: null, isIncome: true },
  }),
);
await command({
  commandType: "create_transaction",
  payload: {
    row: {
      accountId,
      categoryId: incomeId,
      date,
      amount: 350_000 * demoScale,
      payee: "Salary",
      cleared: true,
    },
  },
});
const everydayId = requireId(
  await command({ commandType: "create_category_group", payload: { name: "Everyday" } }),
);
const billsId = requireId(
  await command({ commandType: "create_category_group", payload: { name: "Bills & essentials" } }),
);
const savingsId = requireId(
  await command({ commandType: "create_category_group", payload: { name: "Looking ahead" } }),
);
const demoIcons = {
  Groceries: "basket",
  "Eating out": "utensils",
  Coffee: "coffee",
  Transport: "bus",
  Rent: "home",
  Utilities: "bolt",
  Holiday: "plane",
  "Emergency fund": "shield",
  "Little things": "book",
} satisfies Record<string, CategoryIcon>;
const examples = [
  {
    name: "Groceries",
    groupId: everydayId,
    assigned: 45_000,
    spent: 18_420,
    target: 45_000,
    payee: "Whole Foods",
  },
  {
    name: "Eating out",
    groupId: everydayId,
    assigned: 18_000,
    spent: 9_350,
    target: 18_000,
    payee: "Noodle House",
  },
  {
    name: "Coffee",
    groupId: everydayId,
    assigned: 6_000,
    spent: 6_800,
    target: 6_000,
    payee: "Corner Coffee",
  },
  {
    name: "Transport",
    groupId: everydayId,
    assigned: 12_000,
    spent: 3_200,
    target: 12_000,
    payee: "Metro",
  },
  {
    name: "Rent",
    groupId: billsId,
    assigned: 125_000,
    spent: 125_000,
    target: null,
    payee: "Rent",
  },
  {
    name: "Utilities",
    groupId: billsId,
    assigned: 18_000,
    spent: 8_200,
    target: 18_000,
    payee: "Electric",
  },
  { name: "Holiday", groupId: savingsId, assigned: 35_000, spent: 0, target: 40_000, payee: null },
  {
    name: "Emergency fund",
    groupId: savingsId,
    assigned: 50_000,
    spent: 0,
    target: 50_000,
    payee: null,
  },
  {
    name: "Little things",
    groupId: everydayId,
    assigned: 9_000,
    spent: 1_240,
    target: null,
    payee: "Bookshop",
  },
];
let utilitiesId = "";
for (const example of examples) {
  const categoryId = requireId(
    await command({
      commandType: "create_category",
      payload: {
        name: example.name,
        groupId: example.groupId,
        icon: Object.entries(demoIcons).find(([name]) => name === example.name)?.[1],
      },
    }),
  );
  if (example.name === "Utilities") utilitiesId = categoryId;
  await command({
    commandType: "set_budget_amount",
    payload: { month: toMonthInt(month), categoryId, amount: example.assigned * demoScale },
  });
  if (example.target)
    await command({
      commandType: "update_category",
      payload: {
        id: categoryId,
        goalDef: JSON.stringify({ type: "monthly", amount: example.target * demoScale }),
      },
    });
  if (example.spent)
    await command({
      commandType: "create_transaction",
      payload: {
        row: {
          accountId,
          categoryId,
          date,
          amount: -example.spent * demoScale,
          payee: example.payee,
          cleared: true,
        },
      },
    });
}
await command({
  commandType: "create_transaction",
  payload: {
    row: { accountId, date, amount: -1_800 * demoScale, payee: "Local store", cleared: true },
  },
});
const upcomingDate = formatCalendarDate(
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3),
);
await command({
  commandType: "create_schedule",
  payload: {
    schedule: {
      name: "Internet",
      accountId,
      categoryId: utilitiesId,
      amount: -5_900 * demoScale,
      startDate: upcomingDate,
      nextDate: upcomingDate,
      recurrenceRules: JSON.stringify({ type: "monthly" }),
      active: true,
    },
  },
});

// The local shims implement the runtime methods used by the REST handlers.
const router = createRouter({
  ...env,
  // SAFETY: SQLite shim supplies the prepare, exec, and transactional batch methods used here.
  MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
  // SAFETY: The local upload mock supplies get, put, and delete used by Money's upload handlers.
  UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
});
const apiServer = createHttpServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(`http://localhost:8788${incoming.url ?? "/"}`, {
      method: incoming.method,
      headers,
      body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined,
    });
    const response = await router.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500);
    outgoing.end("Demo request failed");
  }
});
await new Promise<void>((resolve, reject) => {
  apiServer.once("error", reject);
  apiServer.listen(8788, "127.0.0.1", resolve);
});
// This local harness uses the client-only Vite path and the real REST router with in-memory SQLite.
process.env.VITEST = "1";
const vite = await createServer({
  root: fileURLToPath(new URL(".", import.meta.url)),
  configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8788" },
  },
});
await vite.listen();
console.log("Money demo: http://localhost:5173 — sample data resets when stopped");
async function stop() {
  await vite.close();
  apiServer.close();
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
