import { parseAmountInput } from "./money-amount";

/**
 * CSV Parser — ported from Actual Budget (MIT)
 * https://github.com/actualbudget/actual
 * Original copyright: James Long and contributors
 *
 * Parses CSV bank export files into structured transaction data.
 * Handles various formats: auto-detect delimiter, header row, date formats,
 * amount columns (including IN/OUT split columns).
 */

export interface CsvRow {
  date: string;
  amount: number;
  payee?: string;
  notes?: string;
  category?: string;
  importedDescription?: string;
}

export interface CsvImportResult {
  rows: CsvRow[];
  errors: string[];
  detectedFields: CsvFieldMap;
}

export interface CsvFieldMap {
  date: string;
  amount: string;
  payee?: string;
  notes?: string;
  in?: string;
  out?: string;
  description?: string;
}

/**
 * Detect the delimiter used in a CSV text.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;

  if (tabCount > commaCount && tabCount > semicolonCount) return "\t";
  if (semicolonCount > commaCount && semicolonCount > tabCount) return ";";
  return ",";
}

/**
 * Try to detect which columns are which by matching header names to known patterns.
 */
function detectFieldMap(headers: string[]): CsvFieldMap {
  const map: CsvFieldMap = { date: "", amount: "" };
  const lower = headers.map((h) => h.toLowerCase().trim());

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i]!;

    // Date
    if (/^(date|tanggal|tgl|posted|posting|trans.?date|transaction.?date)$/.test(h)) {
      map.date = headers[i]!;
      continue;
    }

    // Amount (single column)
    if (/^(amount|jumlah|nominal|value|sum|betrag|ammount)$/.test(h)) {
      map.amount = headers[i]!;
      continue;
    }

    // IN/OUT split columns (common in Indonesian bank CSVs)
    if (/^(debit|dk|keluar|out|withdrawal|betaling|payment)$/.test(h)) {
      map.out = headers[i]!;
      continue;
    }
    if (/^(credit|cr|masuk|in|deposit|storting|income)$/.test(h)) {
      map.in = headers[i]!;
      continue;
    }

    // Payee
    if (
      /^(payee|merchant|beneficiary|counterparty|name|description|desc|narasi|keterangan|recipient|party)$/.test(
        h,
      )
    ) {
      map.payee = headers[i]!;
      continue;
    }

    // Notes / memo
    if (/^(notes|memo|note|catatan|remark|reference|ref)$/.test(h)) {
      map.notes = headers[i]!;
      continue;
    }

    // Full description (may contain both payee and notes)
    if (/^(description|desc|narasi|keterangan|details|detail|memo)$/.test(h)) {
      map.description = headers[i]!;
      continue;
    }
  }

  return map;
}

/**
 * Try to parse a date string in various formats.
 * Returns YYYY-MM-DD or null.
 */
function parseDate(value: string): string | null {
  const trimmed = value.trim();

  // YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const mdyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // Mon DD, YYYY or DD Mon YYYY
  const textMatch = trimmed.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/);
  if (textMatch) {
    const months = new Map<string, string>(
      Object.entries({
        jan: "01",
        feb: "02",
        mar: "03",
        apr: "04",
        may: "05",
        jun: "06",
        jul: "07",
        aug: "08",
        sep: "09",
        oct: "10",
        nov: "11",
        dec: "12",
      }),
    );
    const monthStr = textMatch[1]!.toLowerCase().slice(0, 3);
    const month = months.get(monthStr);
    if (month) {
      return `${textMatch[3]}-${month}-${textMatch[2]!.padStart(2, "0")}`;
    }
  }

  // YYYYMMDD (no separators)
  const yyyymmdd = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) {
    return `${yyyymmdd[1]}-${yyyymmdd[2]}-${yyyymmdd[3]}`;
  }

  return null;
}

/**
 * Parse a numeric amount string to cents (integer).
 * Handles "1,234.56", "1.234,56", "(1,234.56)" (parentheses = negative).
 */
function parseAmount(value: string): number | null {
  const trimmed = value.trim();

  if (!trimmed) return null;

  let negative = false;
  let clean = trimmed;

  // Handle parentheses for negative
  if (clean.startsWith("(") && clean.endsWith(")")) {
    negative = true;
    clean = clean.slice(1, -1);
  }

  // Handle leading minus
  if (clean.startsWith("-")) {
    negative = true;
    clean = clean.slice(1);
  }

  const rupiah = /^(?:Rp\.?|IDR)/i.test(clean.trim());
  clean = clean.trim().replace(/^(?:Rp\.?|IDR|USD|[$€£])\s*/i, "");
  // A trailing comma decimal or dot-grouped whole amount uses Indonesian separators.
  const commaDecimal =
    clean.lastIndexOf(",") > clean.lastIndexOf(".") && !/^\d{1,3}(?:,\d{3})+$/.test(clean);
  const dotGroups = /^\d{1,3}(?:\.\d{3})+$/.test(clean);
  const amount = parseAmountInput(
    clean,
    rupiah ? "IDR" : "USD",
    commaDecimal || dotGroups ? "dot-comma" : "comma-dot",
  );
  if (!Number.isSafeInteger(amount)) return null;
  return negative ? -amount : amount;
}

/**
 * Split a CSV line into fields, respecting quoted values.
 */
function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Main entry point: parse a CSV string into structured rows.
 */
export function parseCsv(text: string, fieldMap?: CsvFieldMap): CsvImportResult {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["Empty CSV"], detectedFields: { date: "", amount: "" } };
  }

  const delimiter = detectDelimiter(text);
  const headers = splitLine(lines[0]!, delimiter);
  const map = fieldMap ?? detectFieldMap(headers);
  const headerIndex = new Map(headers.map((h, i) => [h.trim(), i]));

  const dateIdx = map.date ? headerIndex.get(map.date) : -1;
  const amountIdx = map.amount ? headerIndex.get(map.amount) : -1;
  const payeeIdx = map.payee ? headerIndex.get(map.payee) : -1;
  const notesIdx = map.notes ? headerIndex.get(map.notes) : -1;
  const inIdx = map.in ? headerIndex.get(map.in) : -1;
  const outIdx = map.out ? headerIndex.get(map.out) : -1;
  const descIdx = map.description ? headerIndex.get(map.description) : -1;

  if (dateIdx === undefined || dateIdx < 0) {
    return { rows: [], errors: ["Could not detect date column"], detectedFields: map };
  }

  const rows: CsvRow[] = [];
  const dataLines = lines.slice(1); // skip header

  for (let lineIdx = 0; lineIdx < dataLines.length; lineIdx++) {
    const line = dataLines[lineIdx]!;
    const fields = splitLine(line, delimiter);

    const getField = (idx: number | undefined): string | undefined => {
      if (idx === undefined || idx < 0 || idx >= fields.length) return undefined;
      return fields[idx];
    };

    // Date
    const rawDate = getField(dateIdx);
    if (!rawDate) {
      errors.push(`Line ${lineIdx + 2}: missing date`);
      continue;
    }
    const date = parseDate(rawDate);
    if (!date) {
      errors.push(`Line ${lineIdx + 2}: could not parse date "${rawDate}"`);
      continue;
    }

    // Amount
    let amount: number | null = null;

    if (amountIdx !== undefined && amountIdx >= 0) {
      const rawAmount = getField(amountIdx);
      if (rawAmount) amount = parseAmount(rawAmount);
    }

    // Handle IN/OUT split columns
    if (amount === null && (inIdx !== undefined || outIdx !== undefined)) {
      const inVal = inIdx !== undefined ? getField(inIdx) : undefined;
      const outVal = outIdx !== undefined ? getField(outIdx) : undefined;

      if (inVal && parseAmount(inVal) !== null && parseAmount(inVal)! > 0) {
        amount = parseAmount(inVal);
      } else if (outVal && parseAmount(outVal) !== null && parseAmount(outVal)! > 0) {
        amount = parseAmount(outVal);
        if (amount !== null) amount = -amount; // outflows are negative
      }
    }

    if (amount === null) {
      errors.push(`Line ${lineIdx + 2}: could not parse amount`);
      continue;
    }

    // Payee / description
    let payee = payeeIdx !== undefined ? getField(payeeIdx) : undefined;
    const description = descIdx !== undefined ? getField(descIdx) : undefined;

    // If no payee column but we have a description column, use description
    if (!payee && description) {
      payee = description.split(/[|\n]/)[0]?.trim();
    }

    // Notes
    let notes = notesIdx !== undefined ? getField(notesIdx) : undefined;
    if (!notes && description && payee) {
      // If description has more content after the payee part, use as notes
      const descParts = description.split(/[|\n]/);
      if (descParts.length > 1) {
        notes = descParts.slice(1).join(" | ").trim();
      }
    }

    rows.push({
      date,
      amount,
      payee: payee?.trim() || undefined,
      notes: notes?.trim() || undefined,
      importedDescription: description?.trim() || undefined,
    });
  }

  return { rows, errors, detectedFields: map };
}
