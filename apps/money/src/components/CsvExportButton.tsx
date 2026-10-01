import { createSignal } from "solid-js";
import MoneyIcon from "./MoneyIcon";
import { emitOperationFeedback } from "../lib/operation-feedback";
export default function CsvExportButton(props: { accountId?: string }) {
  const [busy, setBusy] = createSignal(false),
    [failed, setFailed] = createSignal(false);
  async function download() {
    if (busy()) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(
        "/api/export/csv" +
          (props.accountId ? "?accountId=" + encodeURIComponent(props.accountId) : ""),
      );
      if (!response.ok) throw Error("Could not download transactions.");
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement("a");
      link.href = url;
      link.download = "shedflare-transactions.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      setFailed(true);
      emitOperationFeedback({
        kind: "error",
        message: caught instanceof Error ? caught.message : "Could not download transactions.",
        undoable: false,
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button class="btn btn-secondary" disabled={busy()} onClick={() => void download()}>
      {busy() ? "Downloading…" : failed() ? "Retry export" : "Export CSV"}
      <MoneyIcon name="arrow" size={16} />
    </button>
  );
}
