export type FormulaValue = number | string | boolean | null;
export type FormulaResult = FormulaValue | FormulaError;

export class FormulaError extends Error {
  readonly token: string;
  readonly code: string;
  constructor(token: string, message?: string) {
    super(message ?? token);
    this.token = token;
    this.code = token;
  }
}

export interface SheetLookup {
  getCell(row: number, col: number): FormulaResult;
  getSheet?(name: string): SheetLookup | undefined;
}

export type FormulaArg = FormulaResult | FormulaResult[][];
export type FormulaFunction = (args: FormulaArg[]) => FormulaResult;

export function asNumber(value: FormulaResult): number {
  if (value instanceof FormulaError) throw value;
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new FormulaError("#VALUE!");
  return parsed;
}

export function asText(value: FormulaResult) {
  if (value instanceof FormulaError) throw value;
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

export function asTruthy(value: FormulaResult) {
  if (value instanceof FormulaError) throw value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return false;
}

export function flattenGrid(value: FormulaArg | FormulaResult[][]): FormulaResult[] {
  if (!Array.isArray(value)) return [value];
  const result: FormulaResult[] = [];
  for (const row of value) {
    if (Array.isArray(row)) result.push(...row);
    else result.push(row);
  }
  return result;
}

export function flattenArgs(values: FormulaArg[]): FormulaResult[] {
  const result: FormulaResult[] = [];
  for (const value of values) result.push(...flattenGrid(value));
  return result;
}

export function numericArgs(values: FormulaResult[]) {
  return values.filter((value): value is number => typeof value === "number");
}

export function displayFormulaValue(value: FormulaResult) {
  if (value instanceof FormulaError) return value.token;
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "#NUM!";
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(12)));
  }
  return value;
}

export function excelSerialFromDate(date: Date) {
  return date.getTime() / 86400000 + 25569;
}

export function dateFromExcelSerial(serial: number) {
  return new Date(Math.round((serial - 25569) * 86400000));
}

export function excelSerialFromYmd(year: number, month: number, day: number) {
  return Date.UTC(year, month - 1, day) / 86400000 + 25569;
}

export function ymdFromExcelSerial(serial: number) {
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}
