import * as fs from "fs/promises";
import * as path from "path";
import * as XLSX from "xlsx";

const EXTS = new Set([".xlsx", ".xlsm", ".xls", ".csv"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".vs", ".idea", "build", "coverage", "vendor"]);
const MAX_FILES = 400;
const MAX_ROWS = 5000;
const MAX_COLS = 64;
const MAX_BYTES = 30 * 1024 * 1024;

export interface ExcelSheetMeta {
  id: string;
  file: string;
  fileName: string;
  relative: string;
  sheet: string;
  order: number;
  rowOffset: number;
  rowCount: number;
  dataCount: number;
  colCount: number;
  headers: string[];
  truncated: boolean;
}

export interface ExcelSheetPage {
  id: string;
  file: string;
  fileName: string;
  relative: string;
  sheet: string;
  order: number;
  columns: { letter: string; name: string }[];
  headerRow: number;
  rows: { row: number; cells: string[] }[];
  total: number;
  offset: number;
  focusRow: number;
  truncated: boolean;
}

export interface ExcelCatalog {
  source: string;
  scannedAt: number;
  sheets: ExcelSheetMeta[];
  warnings: string[];
}

export interface ExcelSearchHit {
  sheetId: string;
  file: string;
  fileName: string;
  relative: string;
  sheet: string;
  /** 最佳命中的 Excel 行号；0 表示只匹配到表名 */
  row: number;
  /** 该 Sheet 内命中的行数 */
  count: number;
  preview: string;
}

interface IndexedSheet extends ExcelSheetMeta {
  rows: string[][];
}

interface SheetCache {
  root: string;
  at: number;
  sheets: IndexedSheet[];
  warnings: string[];
}

let cache: SheetCache | null = null;

export async function excelCatalog(root: string, force = false): Promise<ExcelCatalog> {
  const abs = path.resolve(root || "");
  const indexed = await loadSheets(abs, force);
  return {
    source: abs,
    scannedAt: Date.now(),
    sheets: indexed.sheets.map(({ rows: _rows, ...meta }) => meta),
    warnings: indexed.warnings,
  };
}

export async function excelPage(
  root: string,
  id: string,
  options?: { offset?: number; limit?: number; focusRow?: number },
): Promise<ExcelSheetPage | null> {
  const indexed = await loadSheets(path.resolve(root || ""), false);
  const sheet = indexed.sheets.find((item) => item.id === id);
  if (!sheet) return null;
  // rows[0] 是表头，对应 Excel 行号 rowOffset + 1
  const data = sheet.rows.slice(1).map((cells, index) => ({
    row: sheet.rowOffset + index + 2,
    cells,
  }));
  const limit = clamp(options?.limit ?? 300, 1, 800);
  const focusRow = options?.focusRow ?? 0;
  let offset = options?.offset ?? 0;
  if (options?.offset == null && focusRow > 0) {
    const at = data.findIndex((row) => row.row === focusRow);
    offset = at >= 0 ? Math.max(0, at - 2) : 0;
  }
  offset = clamp(offset, 0, data.length);
  return {
    id: sheet.id,
    file: sheet.file,
    fileName: sheet.fileName,
    relative: sheet.relative,
    sheet: sheet.sheet,
    order: sheet.order,
    columns: columnsOf(sheet),
    headerRow: sheet.rows.length ? sheet.rowOffset + 1 : 0,
    rows: data.slice(offset, offset + limit),
    total: data.length,
    offset,
    focusRow,
    truncated: sheet.truncated,
  };
}

export interface ExcelCellEdit {
  id: string;
  /** Excel 行号，从 1 开始 */
  row: number;
  /** 列序号，从 0 开始 */
  col: number;
  value: string;
}

export interface ExcelEditResult {
  ok: boolean;
  error?: string;
  page?: ExcelSheetPage | null;
}

/** 写回单元格并立即失效缓存（仅支持可写的 xlsx/xlsm/csv）。 */
export async function excelUpdateCell(root: string, edit: ExcelCellEdit): Promise<ExcelEditResult> {
  const absRoot = path.resolve(root || "");
  const indexed = await loadSheets(absRoot, false);
  const sheet = indexed.sheets.find((item) => item.id === edit.id);
  if (!sheet) return { ok: false, error: "找不到该表" };
  const ext = path.extname(sheet.file).toLowerCase();
  if (ext === ".xls") return { ok: false, error: "老的 .xls 格式不支持编辑，请另存为 xlsx" };
  const rowIndex = Math.floor(Number(edit.row)) - 1;
  const colIndex = Math.floor(Number(edit.col));
  if (!Number.isFinite(rowIndex) || rowIndex < 0 || rowIndex > 1_048_575) {
    return { ok: false, error: "行号无效" };
  }
  if (!Number.isFinite(colIndex) || colIndex < 0 || colIndex > 16383) {
    return { ok: false, error: "列号无效" };
  }
  try {
    const book = XLSX.readFile(sheet.file, { cellDates: true, dense: false });
    const ws = book.Sheets[sheet.sheet];
    if (!ws) return { ok: false, error: "找不到工作表" };
    const addr = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
    const text = String(edit.value ?? "");
    if (!text) {
      delete ws[addr];
    } else {
      ws[addr] = { t: "s", v: text };
    }
    // 放宽 !ref，避免新增到边界外的单元格被丢弃
    const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    range.s.r = Math.min(range.s.r, rowIndex);
    range.s.c = Math.min(range.s.c, colIndex);
    range.e.r = Math.max(range.e.r, rowIndex);
    range.e.c = Math.max(range.e.c, colIndex);
    ws["!ref"] = XLSX.utils.encode_range(range);
    XLSX.writeFile(book, sheet.file, { cellDates: true });
    cache = null;
    const page = await excelPage(absRoot, edit.id, {});
    return { ok: true, page };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function excelSearch(root: string, query: string, limit = 40): Promise<ExcelSearchHit[]> {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const indexed = await loadSheets(path.resolve(root || ""), false);
  const hits: { hit: ExcelSearchHit; score: number }[] = [];
  for (const sheet of indexed.sheets) {
    const fileSheet = `${sheet.fileName}\n${sheet.relative}\n${sheet.sheet}`.toLowerCase();
    let bestScore = -1;
    let bestRow = 0;
    let bestPreview = "";
    let count = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      const cells = sheet.rows[i];
      const line = cells.join("\t").toLowerCase();
      if (!tokens.every((token) => fileSheet.includes(token) || line.includes(token))) continue;
      if (!tokens.some((token) => line.includes(token))) continue;
      count += 1;
      const score = scoreRow(tokens, fileSheet, cells);
      const row = sheet.rowOffset + i + 1;
      if (score > bestScore || (score === bestScore && (bestRow === 0 || row < bestRow))) {
        bestScore = score;
        bestRow = row;
        bestPreview = previewCells(cells);
      }
    }
    const nameMatch = tokens.every((token) => fileSheet.includes(token));
    if (!count && !nameMatch) continue;
    hits.push({
      score: count ? bestScore : 30,
      hit: {
        sheetId: sheet.id,
        file: sheet.file,
        fileName: sheet.fileName,
        relative: sheet.relative,
        sheet: sheet.sheet,
        row: bestRow,
        count,
        preview: bestPreview || previewCells(sheet.rows[0] ?? []) || "打开整张表",
      },
    });
  }
  hits.sort((a, b) => b.score - a.score || b.hit.count - a.hit.count || a.hit.row - b.hit.row);
  return hits.slice(0, limit).map((item) => item.hit);
}

async function loadSheets(root: string, force: boolean): Promise<SheetCache> {
  if (!force && cache && cache.root === root && Date.now() - cache.at < 60_000) return cache;
  const warnings: string[] = [];
  if (!root) {
    cache = { root, at: Date.now(), sheets: [], warnings: ["未配置扫描目录"] };
    return cache;
  }
  const files: string[] = [];
  await walk(root, files);
  files.sort((a, b) => a.localeCompare(b, "zh", { numeric: true, sensitivity: "base" }));
  const sheets: IndexedSheet[] = [];
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) {
      warnings.push(`${relativeOf(root, file)} 超过 30MB，已跳过`);
      continue;
    }
    try {
      const text = await fs.readFile(file, "utf8").catch(() => "");
      void text;
      const book = XLSX.readFile(file, { cellDates: true, dense: false });
      const relative = relativeOf(root, file);
      book.SheetNames.forEach((sheetName, index) => {
        const parsed = parseSheet(sheetName, book.Sheets[sheetName]);
        const width = parsed.rows.reduce((max, row) => Math.max(max, row.length), 0);
        const headers = (parsed.rows[0] ?? []).map((cell, col) => cell || columnLetter(col));
        sheets.push({
          id: `${relative}\u0000${sheetName}\u0000${index}`,
          file,
          fileName: path.basename(file),
          relative,
          sheet: sheetName,
          order: sheets.length,
          rowOffset: parsed.rowOffset,
          rowCount: parsed.rows.length ? parsed.rowOffset + parsed.rows.length : 0,
          dataCount: Math.max(0, parsed.rows.length - 1),
          colCount: width,
          headers: headers.slice(0, 12),
          truncated: parsed.truncated,
          rows: parsed.rows,
        });
      });
    } catch (error) {
      warnings.push(`${relativeOf(root, file)} 无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cache = { root, at: Date.now(), sheets, warnings };
  return cache;
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const name = entry.name;
    if (!name || name.startsWith("~$") || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walk(full, out);
      continue;
    }
    if (entry.isFile() && EXTS.has(path.extname(name).toLowerCase())) out.push(full);
  }
}

interface ParsedSheet {
  rowOffset: number;
  rows: string[][];
  truncated: boolean;
}

function parseSheet(name: string, sheet: XLSX.WorkSheet | undefined): ParsedSheet {
  if (!sheet || !sheet["!ref"]) return { rowOffset: 0, rows: [], truncated: false };
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const truncated = range.e.r - range.s.r + 1 > MAX_ROWS || range.e.c + 1 > MAX_COLS;
  const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
  const lastCol = Math.min(range.e.c, MAX_COLS - 1);
  const rows: string[][] = [];
  const rowOffset = range.s.r;
  for (let r = range.s.r; r <= lastRow; r++) {
    const row: string[] = [];
    for (let c = 0; c <= lastCol; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      row.push(cell ? formatCell(cell) : "");
    }
    // 保留表内所有行（含空行），否则行号与 Excel 对不上
    rows.push(row);
  }
  void name;
  return { rowOffset, rows, truncated };
}

function formatCell(cell: XLSX.CellObject): string {
  try {
    const formatted = XLSX.utils.format_cell(cell);
    if (formatted) return clean(formatted);
  } catch {
    // 个别单元格没有数字格式，退回原始值
  }
  return clean(cell.v);
}

function clean(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    const date = `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
    if (value.getHours() || value.getMinutes() || value.getSeconds()) {
      return `${date} ${p(value.getHours())}:${p(value.getMinutes())}`;
    }
    return date;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    const record = value as { text?: unknown; w?: unknown };
    if (record.text != null) return clean(record.text);
    if (record.w != null) return clean(record.w);
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

function columnsOf(sheet: IndexedSheet): { letter: string; name: string }[] {
  const header = sheet.rows[0] ?? [];
  const width = Math.max(sheet.colCount, header.length, 1);
  const columns: { letter: string; name: string }[] = [];
  for (let i = 0; i < width; i++) {
    columns.push({ letter: columnLetter(i), name: header[i] || columnLetter(i) });
  }
  return columns;
}

function scoreRow(tokens: string[], fileSheet: string, cells: string[]): number {
  let score = 0;
  const lowered = cells.map((cell) => cell.toLowerCase());
  for (const token of tokens) {
    if (lowered.some((cell) => cell === token)) score += 80;
    else if (lowered.some((cell) => cell.includes(token))) score += 40;
    if (fileSheet.includes(token)) score += 12;
  }
  return score;
}

function previewCells(cells: string[]): string {
  return cells.map((cell) => cell.trim()).filter(Boolean).slice(0, 8).join("  ·  ").slice(0, 180);
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function relativeOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
