/**
 * Client-side CSV export (used by DataTable's "Export CSV" for the rows currently shown).
 * RFC 4180 quoting, UTF-8 BOM so Excel opens Indian-language text and the rupee sign correctly.
 * Codes are kept as text (a leading apostrophe is NOT added; Excel users should import as text).
 */
import { saveBlob } from '@/api/client';

export type CsvCell = string | number | boolean | null | undefined;

/** Quote one cell. */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build CSV text from a header row and data rows. */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Save CSV text as a file. */
export function downloadCsv(filename: string, header: string[], rows: CsvCell[][]): void {
  const blob = new Blob(['﻿', toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  saveBlob(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}
