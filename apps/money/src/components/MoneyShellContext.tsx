import { createContext, useContext, type JSX } from "solid-js";

export type OpenTransactionOptions = {
  initialAccountId?: string;
  initialCategoryId?: string;
  onCreated?: () => void | Promise<void>;
};

export type MoneyShellActions = {
  openTransaction: (options?: OpenTransactionOptions) => void;
  openSearch: () => void;
};

const MoneyShellContext = createContext<MoneyShellActions>();

export function MoneyShellProvider(props: { value: MoneyShellActions; children: JSX.Element }) {
  return (
    <MoneyShellContext.Provider value={props.value}>{props.children}</MoneyShellContext.Provider>
  );
}

export function useMoneyShell(): MoneyShellActions {
  const value = useContext(MoneyShellContext);
  if (!value) throw new Error("useMoneyShell must be used inside the money layout");
  return value;
}
