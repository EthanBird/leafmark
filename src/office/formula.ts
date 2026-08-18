import { callFunction, type FormulaArg } from "./formula-functions";
import {
  FormulaError,
  type FormulaResult,
  type SheetLookup,
  asNumber,
  asText,
  asTruthy,
  displayFormulaValue,
} from "./formula-types";

export {
  FormulaError,
  displayFormulaValue,
  type FormulaResult,
  type SheetLookup,
};

interface Token {
  kind: "number" | "string" | "ref" | "range" | "name" | "op" | "paren" | "comma" | "error";
  value: string;
}

const OPERATORS = ["<>", "<=", ">=", "&", "+", "-", "*", "/", "^", "=", "<", ">", "%"];

export interface FormulaOrigin {
  row?: number;
  col?: number;
  now?: () => Date;
}

export function colName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export function parseCellRef(ref: string) {
  const match = /^(?:(?:'([^']+)'|([^'!]+))!)?(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const col = lettersToIndex(match[4]);
  const row = Number(match[6]) - 1;
  if (col < 0 || row < 0) return null;
  return {
    sheet: match[1] || match[2] || "",
    col,
    row,
    absCol: match[3] === "$",
    absRow: match[5] === "$",
  };
}

export function formatCellRef(row: number, col: number) {
  return `${colName(col)}${row + 1}`;
}

export function formatParsedRef(parsed: NonNullable<ReturnType<typeof parseCellRef>>) {
  const col = `${parsed.absCol ? "$" : ""}${colName(parsed.col)}`;
  const row = `${parsed.absRow ? "$" : ""}${parsed.row + 1}`;
  const cell = `${col}${row}`;
  if (!parsed.sheet) return cell;
  const sheet = /[^A-Za-z0-9_.]/.test(parsed.sheet) ? `'${parsed.sheet}'` : parsed.sheet;
  return `${sheet}!${cell}`;
}

function lettersToIndex(letters: string) {
  let index = 0;
  for (const char of letters.toUpperCase()) {
    if (char < "A" || char > "Z") return -1;
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const input = source.trim();
  while (index < input.length) {
    const char = input[index];
    if (char === " " || char === "\t" || char === "\n") {
      index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char });
      index += 1;
      continue;
    }
    if (char === "," || char === ";") {
      tokens.push({ kind: "comma", value: "," });
      index += 1;
      continue;
    }
    const op = OPERATORS.find((item) => input.startsWith(item, index));
    if (op) {
      tokens.push({ kind: "op", value: op });
      index += op.length;
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += input[index];
        index += 1;
      }
      tokens.push({ kind: "string", value });
      continue;
    }
    if (char === "#") {
      const error = /#[A-Z0-9\/!?]+/.exec(input.slice(index))?.[0] ?? "#VALUE!";
      tokens.push({ kind: "error", value: error });
      index += error.length;
      continue;
    }
    const range = /^(?:(?:'[^']+'|[A-Za-z0-9_\u0080-\uffff.]+)!)?(?:\$?[A-Za-z]+\$?\d+):(?:\$?[A-Za-z]+\$?\d+)/.exec(input.slice(index));
    if (range) {
      tokens.push({ kind: "range", value: range[0] });
      index += range[0].length;
      continue;
    }
    const ref = /^(?:(?:'[^']+'|[A-Za-z0-9_\u0080-\uffff.]+)!)?\$?[A-Za-z]+\$?\d+/.exec(input.slice(index));
    if (ref && /[A-Za-z]/.test(ref[0]) && /\d/.test(ref[0]) && !/^[A-Za-z]+\(/.test(input.slice(index))) {
      const after = input[index + ref[0].length];
      if (after !== "(") {
        tokens.push({ kind: "ref", value: ref[0] });
        index += ref[0].length;
        continue;
      }
    }
    if (/[0-9.]/.test(char)) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(input.slice(index));
      if (match) {
        tokens.push({ kind: "number", value: match[0] });
        index += match[0].length;
        continue;
      }
    }
    const name = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff.]*/.exec(input.slice(index));
    if (name) {
      tokens.push({ kind: "name", value: name[0] });
      index += name[0].length;
      continue;
    }
    throw new FormulaError("#NAME?", `无法解析公式：${input.slice(index, index + 8)}`);
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly lookup: SheetLookup,
    private readonly origin: Required<Pick<FormulaOrigin, "row" | "col">> & { now: () => Date },
  ) {}

  parse(): FormulaResult {
    if (!this.tokens.length) return null;
    const value = this.parseComparison();
    if (this.index < this.tokens.length) throw new FormulaError("#VALUE!", "公式有多余内容");
    return value;
  }

  private parseComparison(): FormulaResult {
    let left = this.parseConcat();
    while (this.matchOp("=", "<>", "<", ">", "<=", ">=")) {
      const op = this.previous().value;
      const right = this.parseConcat();
      left = compare(left, right, op);
    }
    return left;
  }

  private parseConcat(): FormulaResult {
    let left = this.parseAdd();
    while (this.matchOp("&")) {
      const right = this.parseAdd();
      left = `${asText(left)}${asText(right)}`;
    }
    return left;
  }

  private parseAdd(): FormulaResult {
    let left = this.parseMul();
    while (this.matchOp("+", "-")) {
      const op = this.previous().value;
      const right = this.parseMul();
      left = op === "+" ? asNumber(left) + asNumber(right) : asNumber(left) - asNumber(right);
    }
    return left;
  }

  private parseMul(): FormulaResult {
    let left = this.parsePow();
    while (this.matchOp("*", "/")) {
      const op = this.previous().value;
      const right = this.parsePow();
      if (op === "/") {
        const divisor = asNumber(right);
        if (divisor === 0) throw new FormulaError("#DIV/0!");
        left = asNumber(left) / divisor;
      } else {
        left = asNumber(left) * asNumber(right);
      }
    }
    return left;
  }

  private parsePow(): FormulaResult {
    let left = this.parseUnary();
    if (this.matchOp("^")) {
      const right = this.parsePow();
      left = asNumber(left) ** asNumber(right);
    }
    return left;
  }

  private parseUnary(): FormulaResult {
    if (this.matchOp("+")) return this.parseUnary();
    if (this.matchOp("-")) return -asNumber(this.parseUnary());
    const value = this.parsePrimary();
    if (this.matchOp("%")) return asNumber(value) / 100;
    return value;
  }

  private parsePrimary(): FormulaResult {
    const token = this.peek();
    if (!token) throw new FormulaError("#VALUE!", "公式不完整");
    if (token.kind === "number") {
      this.index += 1;
      return Number(token.value);
    }
    if (token.kind === "string") {
      this.index += 1;
      return token.value;
    }
    if (token.kind === "error") {
      this.index += 1;
      throw new FormulaError(token.value);
    }
    if (token.kind === "ref") {
      this.index += 1;
      return this.resolveRef(token.value);
    }
    if (token.kind === "range") {
      this.index += 1;
      return this.resolveRange(token.value).flat().reduce<number>((sum, item) => sum + (typeof item === "number" ? item : 0), 0);
    }
    if (token.kind === "name") {
      this.index += 1;
      if (this.matchParen("(")) {
        const args: FormulaArg[] = [];
        if (!this.matchParen(")")) {
          do {
            args.push(this.parseArgument());
          } while (this.matchKind("comma"));
          this.expectParen(")");
        }
        return callFunction(token.value.toUpperCase(), args, {
          lookup: this.lookup,
          now: this.origin.now,
          row: this.origin.row,
          col: this.origin.col,
        });
      }
      const constant = token.value.toUpperCase();
      if (constant === "TRUE") return true;
      if (constant === "FALSE") return false;
      throw new FormulaError("#NAME?", token.value);
    }
    if (token.kind === "paren" && token.value === "(") {
      this.index += 1;
      const value = this.parseComparison();
      this.expectParen(")");
      return value;
    }
    throw new FormulaError("#VALUE!");
  }

  private parseArgument(): FormulaArg {
    try {
      if (this.peek()?.kind === "range") return this.resolveRange(this.advance().value);
      return this.parseComparison();
    } catch (error) {
      if (error instanceof FormulaError) return error;
      throw error;
    }
  }

  private resolveRef(ref: string): FormulaResult {
    const parsed = parseCellRef(ref);
    if (!parsed) throw new FormulaError("#REF!");
    const lookup = parsed.sheet ? this.lookup.getSheet?.(parsed.sheet) : this.lookup;
    if (!lookup) throw new FormulaError("#REF!");
    return lookup.getCell(parsed.row, parsed.col);
  }

  private resolveRange(range: string): FormulaResult[][] {
    const [leftRaw, rightRaw] = range.split(":");
    const left = parseCellRef(leftRaw);
    const right = parseCellRef(rightRaw);
    if (!left || !right) throw new FormulaError("#REF!");
    const lookup = left.sheet ? this.lookup.getSheet?.(left.sheet) : this.lookup;
    if (!lookup) throw new FormulaError("#REF!");
    const rowStart = Math.min(left.row, right.row);
    const rowEnd = Math.max(left.row, right.row);
    const colStart = Math.min(left.col, right.col);
    const colEnd = Math.max(left.col, right.col);
    const values: FormulaResult[][] = [];
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const line: FormulaResult[] = [];
      for (let col = colStart; col <= colEnd; col += 1) line.push(lookup.getCell(row, col));
      values.push(line);
    }
    return values;
  }

  private peek() {
    return this.tokens[this.index];
  }

  private previous() {
    return this.tokens[this.index - 1];
  }

  private advance() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private matchOp(...ops: string[]) {
    const token = this.peek();
    if (token?.kind === "op" && ops.includes(token.value)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchKind(kind: Token["kind"]) {
    if (this.peek()?.kind === kind) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchParen(value: "(" | ")") {
    const token = this.peek();
    if (token?.kind === "paren" && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectParen(value: "(" | ")") {
    if (!this.matchParen(value)) throw new FormulaError("#VALUE!", `缺少 ${value}`);
  }
}

function compare(left: FormulaResult, right: FormulaResult, op: string): boolean {
  if (typeof left === "number" || typeof right === "number") {
    const delta = asNumber(left) - asNumber(right);
    if (op === "=") return delta === 0;
    if (op === "<>") return delta !== 0;
    if (op === "<") return delta < 0;
    if (op === ">") return delta > 0;
    if (op === "<=") return delta <= 0;
    return delta >= 0;
  }
  const a = asText(left);
  const b = asText(right);
  if (op === "=") return a === b;
  if (op === "<>") return a !== b;
  if (op === "<") return a < b;
  if (op === ">") return a > b;
  if (op === "<=") return a <= b;
  return a >= b;
}

function rewriteTokens(formula: string, mapRef: (raw: string) => string): string {
  const eq = formula.startsWith("=");
  const source = eq ? formula.slice(1) : formula;
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return formula;
  }
  const rebuilt = tokens.map((token) => {
    if (token.kind === "string") return `"${token.value.replace(/"/g, "\"\"")}"`;
    if (token.kind === "ref") return mapRef(token.value);
    if (token.kind === "range") {
      const [left, right] = token.value.split(":");
      return `${mapRef(left)}:${mapRef(right)}`;
    }
    return token.value;
  }).join("");
  return eq ? `=${rebuilt}` : rebuilt;
}

export function translateFormula(formula: string, deltaRow: number, deltaCol: number): string {
  return rewriteTokens(formula, (raw) => {
    const parsed = parseCellRef(raw);
    if (!parsed) return raw;
    const row = parsed.absRow ? parsed.row : parsed.row + deltaRow;
    const col = parsed.absCol ? parsed.col : parsed.col + deltaCol;
    if (row < 0 || col < 0) return "#REF!";
    return formatParsedRef({ ...parsed, row, col });
  });
}

export function shiftFormula(formula: string, options: {
  rowAt?: number;
  rowDelta?: number;
  colAt?: number;
  colDelta?: number;
  deletedRows?: { start: number; count: number };
  deletedCols?: { start: number; count: number };
}): string {
  const rowAt = options.rowAt ?? 0;
  const rowDelta = options.rowDelta ?? 0;
  const colAt = options.colAt ?? 0;
  const colDelta = options.colDelta ?? 0;
  return rewriteTokens(formula, (raw) => {
    const parsed = parseCellRef(raw);
    if (!parsed) return raw;
    let { row, col } = parsed;
    if (options.deletedRows) {
      const { start, count } = options.deletedRows;
      if (row >= start && row < start + count) return "#REF!";
      if (row >= start + count) row -= count;
    } else if (rowDelta && row >= rowAt) {
      row += rowDelta;
    }
    if (options.deletedCols) {
      const { start, count } = options.deletedCols;
      if (col >= start && col < start + count) return "#REF!";
      if (col >= start + count) col -= count;
    } else if (colDelta && col >= colAt) {
      col += colDelta;
    }
    if (row < 0 || col < 0) return "#REF!";
    return formatParsedRef({ ...parsed, row, col });
  });
}

export function evaluateFormula(
  source: string,
  lookup: SheetLookup,
  visitingOrOrigin?: Set<string> | FormulaOrigin,
): FormulaResult {
  try {
    const formula = source.startsWith("=") ? source.slice(1) : source;
    const origin: FormulaOrigin = visitingOrOrigin instanceof Set || visitingOrOrigin == null ? {} : visitingOrOrigin;
    return new Parser(tokenize(formula), lookup, {
      row: origin.row ?? 0,
      col: origin.col ?? 0,
      now: origin.now ?? (() => new Date()),
    }).parse();
  } catch (error) {
    if (error instanceof FormulaError) return error;
    return new FormulaError("#VALUE!", error instanceof Error ? error.message : String(error));
  }
}

