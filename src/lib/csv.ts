import { civilDate, daysInMonth } from "@/lib/date";

/** RFC 4180-style parser: quoted fields, escaped quotes, CR/LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let hasContent = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };

  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    hasContent = true;
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // handled by the \n that follows
    } else {
      field += char;
    }
  }
  if (hasContent && (field !== "" || row.length > 0)) pushRow();
  return rows;
}

/**
 * The inverse of parseCsv: RFC 4180 output (CRLF line endings, a field quoted
 * whenever it holds a comma, a quote, a line break or edge whitespace, quotes
 * doubled). Prefixed with a UTF-8 byte order mark so spreadsheet apps open
 * accented text correctly; parseCsv strips the mark on the way back in.
 */
export function formatCsv(rows: readonly (readonly string[])[]): string {
  const lines = rows.map((row) => row.map(formatCsvField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

function formatCsvField(value: string): string {
  if (value === "") return "";
  const needsQuotes = /[",\r\n]/.test(value) || value !== value.trim();
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function isDateFormat(value: unknown): value is DateFormat {
  return (
    typeof value === "string" && (DATE_FORMATS as readonly string[]).includes(value)
  );
}

/** Parse a date string in the format the user picked during column mapping. */
export function parseDateWithFormat(
  value: string,
  format: DateFormat,
): Date | null {
  const parts = value.trim().split(/[^0-9]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [a, b, c] = parts.map(Number);
  if ([a, b, c].some((part) => Number.isNaN(part))) return null;

  let year: number;
  let month: number;
  let day: number;
  if (format === "YYYY-MM-DD") {
    [year, month, day] = [a, b, c];
  } else if (format === "MM/DD/YYYY") {
    [month, day, year] = [a, b, c];
  } else {
    [day, month, year] = [a, b, c];
  }

  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return civilDate(year, month, day);
}

/**
 * A yes/no cell, as Cadence's own export writes it in either language ("Yes"
 * / "Sí") and as a spreadsheet might: trimmed, case-insensitive. Anything
 * else - "No", blank, a stray value - is no.
 */
export function parseFlag(value: string): boolean {
  return ["yes", "sí", "si", "true", "1"].includes(value.trim().toLowerCase());
}

/**
 * Amounts as banks export them: "1,234.56", "-$45.00", "(45.00)", "45,00 EUR".
 * Returns a signed number, or null when nothing numeric is present.
 */
export function parseAmount(value: string): number | null {
  let text = value.trim();
  if (!text) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^0-9.,+-]/g, "");
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  if (!text) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European style: 1.234,56
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(/,/g, "");
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}
