import { parseAmountInput, type CurrencyCode, type NumberFormat } from "./money-amount";
import { parseCalendarDate } from "./types";
export const CSV_IMPORT_MAX_ROWS = 200;
export interface CsvRow {
  date: string;
  amount: number;
  payee?: string;
  notes?: string;
  category?: string;
  account?: string;
  importedDescription?: string;
}
export interface CsvFieldMap {
  date: string;
  amount: string;
  payee?: string;
  notes?: string;
  in?: string;
  out?: string;
  description?: string;
  category?: string;
  account?: string;
}
export interface CsvImportResult {
  rows: CsvRow[];
  errors: string[];
  detectedFields: CsvFieldMap;
  headers: string[];
}
export interface CsvOptions {
  currency?: CurrencyCode;
  numberFormat?: NumberFormat;
  dateFormat?: "dmy" | "mdy";
}

// Read records rather than lines: quoted descriptions and notes may contain newlines.
function records(text: string, delimiter: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += char;
      continue;
    }
    if (char === '"') {
      if (value.trim() || closed) throw Error("Unexpected quote in CSV");
      value = "";
      quoted = true;
    } else if (char === delimiter) {
      row.push(value);
      value = "";
      closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      if (row.some((cell) => cell.trim())) result.push(row);
      row = [];
      value = "";
      closed = false;
    } else {
      if (closed && char.trim()) throw Error("Unexpected text after a quoted field");
      if (!closed) value += char;
    }
  }
  if (quoted) throw Error("Unclosed quoted field");
  row.push(value);
  if (row.some((cell) => cell.trim())) result.push(row);
  return result;
}
function delimiter(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? "";
  let winner = ",",
    width = 0;
  for (const candidate of [",", ";", "\t"]) {
    try {
      const count = records(first, candidate)[0]?.length ?? 0;
      if (count > width) {
        winner = candidate;
        width = count;
      }
    } catch {}
  }
  return winner;
}
function detect(headers: string[]): CsvFieldMap {
  const map: CsvFieldMap = { date: "", amount: "" };
  for (const header of headers) {
    const h = header.toLowerCase().trim();
    if (/^(date|tanggal|tgl|posted|posting|trans.?date|transaction.?date)$/.test(h))
      map.date = header;
    else if (/^(amount|jumlah|nominal|value|sum|betrag|ammount)$/.test(h)) map.amount = header;
    else if (/^(debit|debet|dk|keluar|out|withdrawal|payment)$/.test(h)) map.out = header;
    else if (/^(credit|kredit|cr|masuk|in|deposit|income)$/.test(h)) map.in = header;
    else if (/^(payee|merchant|beneficiary|counterparty|name|recipient|party)$/.test(h))
      map.payee = header;
    else if (/^(notes|memo|note|catatan|remark|reference|ref)$/.test(h)) map.notes = header;
    else if (/^(description|desc|narasi|keterangan|details|detail)$/.test(h))
      map.description = header;
    else if (/^(category|kategori)$/.test(h)) map.category = header;
    else if (/^(account|rekening|akun)$/.test(h)) map.account = header;
  }
  return map;
}
function dateValue(value: string, format: CsvOptions["dateFormat"]): string | null {
  let normalized = value.trim();
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(normalized);
  if (slash) {
    const [, a, b, y] = slash;
    normalized =
      format === "mdy"
        ? y + "-" + a.padStart(2, "0") + "-" + b.padStart(2, "0")
        : y + "-" + b.padStart(2, "0") + "-" + a.padStart(2, "0");
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(normalized);
  if (compact) normalized = compact[1] + "-" + compact[2] + "-" + compact[3];
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (iso) normalized = iso[1] + "-" + iso[2].padStart(2, "0") + "-" + iso[3].padStart(2, "0");
  const named = /^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/.exec(normalized);
  if (named) {
    const index = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(named[1].slice(0, 3).toLowerCase());
    if (index >= 0)
      normalized =
        named[3] + "-" + String(index + 1).padStart(2, "0") + "-" + named[2].padStart(2, "0");
  }
  return parseCalendarDate(normalized) ? normalized : null;
}
function amountValue(value: string, options: CsvOptions): number | null {
  let clean = value.trim();
  if (!clean) return null;
  let negative = false;
  if (clean.startsWith("(") && clean.endsWith(")")) {
    negative = true;
    clean = clean.slice(1, -1).trim();
  }
  if (clean.startsWith("-")) {
    negative = true;
    clean = clean.slice(1).trim();
  } else if (clean.startsWith("+")) clean = clean.slice(1).trim();
  const currency = /^(?:Rp\.?|IDR)/i.test(clean) ? "IDR" : (options.currency ?? "USD");
  clean = clean.replace(/^(?:Rp\.?|IDR|USD|[$€£])\s*/i, "");
  const commaDecimal =
    clean.lastIndexOf(",") > clean.lastIndexOf(".") && !/^\d{1,3}(?:,\d{3})+$/.test(clean);
  const dots = /^\d{1,3}(?:\.\d{3})+$/.test(clean);
  const format =
    options.numberFormat ??
    (commaDecimal || dots ? "dot-comma" : /\d \d/.test(clean) ? "space-dot" : "comma-dot");
  const amount = parseAmountInput(clean, currency, format);
  return Number.isSafeInteger(amount) ? (negative ? -amount : amount) : null;
}
export function parseCsv(
  text: string,
  fieldMap?: CsvFieldMap,
  options: CsvOptions = {},
): CsvImportResult {
  const empty: CsvImportResult = {
    rows: [],
    errors: [],
    detectedFields: { date: "", amount: "" },
    headers: [],
  };
  let parsed: string[][];
  try {
    const clean = text.replace(/^\uFEFF/, "");
    parsed = records(clean, delimiter(clean));
  } catch (error) {
    return { ...empty, errors: [error instanceof Error ? error.message : "Invalid CSV"] };
  }
  if (!parsed.length) return { ...empty, errors: ["Empty CSV"] };
  const headers = parsed[0].map((h) => h.trim());
  const map = fieldMap ?? detect(headers);
  const errors: string[] = [],
    rows: CsvRow[] = [];
  if (new Set(headers).size !== headers.length || headers.some((h) => !h))
    return {
      ...empty,
      headers,
      detectedFields: map,
      errors: ["Choose a CSV with distinct column headings"],
    };
  const mapped = (name?: string) => !!name && headers.includes(name);
  if (!mapped(map.date)) errors.push("Choose the date column");
  if (!mapped(map.amount) && !mapped(map.in) && !mapped(map.out))
    errors.push("Choose an amount column or money in/out columns");
  if (errors.length) return { rows, errors, headers, detectedFields: map };
  for (const [index, fields] of parsed.slice(1).entries()) {
    const fail = (message: string) => errors.push("Row " + (index + 2) + ": " + message);
    if (fields.length !== headers.length) {
      fail("column count does not match");
      continue;
    }
    const get = (name?: string) => (name ? (fields[headers.indexOf(name)] ?? "") : "");
    const date = dateValue(get(map.date), options.dateFormat);
    if (!date) {
      fail("invalid date");
      continue;
    }
    let amount: number | null;
    if (mapped(map.amount)) amount = amountValue(get(map.amount), options);
    else {
      const incoming = get(map.in).trim() ? amountValue(get(map.in), options) : 0;
      const outgoing = get(map.out).trim() ? amountValue(get(map.out), options) : 0;
      amount =
        incoming === null ||
        outgoing === null ||
        incoming < 0 ||
        outgoing < 0 ||
        (incoming > 0 && outgoing > 0)
          ? null
          : incoming - outgoing;
    }
    if (amount === null) {
      fail("invalid amount");
      continue;
    }
    const description = get(map.description).trim();
    const payee = get(map.payee).trim() || description.split(/[|\n]/)[0]?.trim();
    const notes =
      get(map.notes) ||
      (description.includes("|") ? description.split("|").slice(1).join(" | ").trim() : "");
    rows.push({
      date,
      amount,
      payee: payee || undefined,
      notes: notes || undefined,
      category: get(map.category).trim() || undefined,
      account: get(map.account).trim() || undefined,
      importedDescription: description || undefined,
    });
  }
  return { rows, errors, headers, detectedFields: map };
}
export interface DuplicateRow {
  date: string;
  amount: number;
  payee?: string | null;
}
export function importRowKey(row: DuplicateRow): string {
  return JSON.stringify([row.date, row.amount, row.payee?.trim().toLocaleLowerCase() ?? ""]);
}
// Consume matches one at a time so two identical legitimate purchases stay two purchases.
export function duplicateRows(
  rows: readonly CsvRow[],
  existing: readonly DuplicateRow[],
): Set<number> {
  const counts = new Map<string, number>();
  for (const row of existing) {
    const key = importRowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = new Set<number>();
  for (const [index, row] of rows.entries()) {
    const key = importRowKey(row),
      count = counts.get(key) ?? 0;
    if (count > 0) {
      result.add(index);
      counts.set(key, count - 1);
    }
  }
  return result;
}
