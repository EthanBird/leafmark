export type FormulaValue = number | string | boolean | null;
export type FormulaResult = FormulaValue | FormulaError;

export class FormulaError extends Error {
  readonly token: string;
  constructor(token: string, message?: string) {
    super(message ?? token);
    this.token = token;
  }
}

export interface SheetLookup {
  getCell(row: number, col: number): FormulaResult;
  getSheet?(name: string): SheetLookup | undefined;
}

interface Token {
  kind: "number" | "string" | "ref" | "range" | "name" | "op" | "paren" | "comma" | "error";
  value: string;
}

const OPERATORS = ["<>", "<=", ">=", "&", "+", "-", "*", "/", "^", "=", "<", ">", "%"];

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
  const match = /^(?:'([^']+)'|([^'!]+))?!?(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(ref.trim());
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
    const ref = /^(?:'[^']+'|[A-Za-z0-9_\u0080-\uffff.]+)!\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+\$?\d+/.exec(input.slice(index));
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
  constructor(private readonly tokens: Token[], private readonly lookup: SheetLookup) {}

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
      left = `${display(left)}${display(right)}`;
    }
    return left;
  }

  private parseAdd(): FormulaResult {
    let left = this.parseMul();
    while (this.matchOp("+", "-")) {
      const op = this.previous().value;
      const right = this.parseMul();
      left = op === "+" ? number(left) + number(right) : number(left) - number(right);
    }
    return left;
  }

  private parseMul(): FormulaResult {
    let left = this.parsePow();
    while (this.matchOp("*", "/")) {
      const op = this.previous().value;
      const right = this.parsePow();
      if (op === "/") {
        const divisor = number(right);
        if (divisor === 0) throw new FormulaError("#DIV/0!");
        left = number(left) / divisor;
      } else {
        left = number(left) * number(right);
      }
    }
    return left;
  }

  private parsePow(): FormulaResult {
    let left = this.parseUnary();
    if (this.matchOp("^")) {
      const right = this.parsePow();
      left = number(left) ** number(right);
    }
    return left;
  }

  private parseUnary(): FormulaResult {
    if (this.matchOp("+")) return this.parseUnary();
    if (this.matchOp("-")) return -number(this.parseUnary());
    const value = this.parsePrimary();
    if (this.matchOp("%")) return number(value) / 100;
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
      return flatten([this.resolveRange(token.value)]).reduce<number>((sum, item) => sum + (typeof item === "number" ? item : 0), 0);
    }
    if (token.kind === "name") {
      this.index += 1;
      if (this.matchParen("(")) {
        const args: Array<FormulaResult | FormulaResult[][]> = [];
        if (!this.matchParen(")")) {
          do {
            const start = this.index;
            if (this.peek()?.kind === "range") {
              args.push(this.resolveRange(this.advance().value));
            } else {
              this.index = start;
              args.push(this.parseComparison());
            }
          } while (this.matchKind("comma"));
          this.expectParen(")");
        }
        return callFunction(token.value.toUpperCase(), args);
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

function number(value: FormulaResult): number {
  if (value instanceof FormulaError) throw value;
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new FormulaError("#VALUE!");
  return parsed;
}

function display(value: FormulaResult) {
  if (value instanceof FormulaError) throw value;
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function compare(left: FormulaResult, right: FormulaResult, op: string): boolean {
  if (typeof left === "number" || typeof right === "number") {
    const delta = number(left) - number(right);
    if (op === "=") return delta === 0;
    if (op === "<>") return delta !== 0;
    if (op === "<") return delta < 0;
    if (op === ">") return delta > 0;
    if (op === "<=") return delta <= 0;
    return delta >= 0;
  }
  const a = display(left);
  const b = display(right);
  if (op === "=") return a === b;
  if (op === "<>") return a !== b;
  if (op === "<") return a < b;
  if (op === ">") return a > b;
  if (op === "<=") return a <= b;
  return a >= b;
}

function flatten(values: Array<FormulaResult | FormulaResult[][]>): FormulaResult[] {
  const result: FormulaResult[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const row of value) result.push(...row);
    } else {
      result.push(value);
    }
  }
  return result;
}

function numbers(values: FormulaResult[]) {
  return values.filter((value): value is number => typeof value === "number");
}

function callFunction(name: string, rawArgs: Array<FormulaResult | FormulaResult[][]>): FormulaResult {
  const args = flatten(rawArgs);
  switch (name) {
    case "SUM": return numbers(args).reduce((sum, value) => sum + value, 0);
    case "AVERAGE": {
      const values = numbers(args);
      if (!values.length) throw new FormulaError("#DIV/0!");
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
    case "MIN": return Math.min(...numbers(args));
    case "MAX": return Math.max(...numbers(args));
    case "COUNT": return numbers(args).length;
    case "COUNTA": return args.filter((value) => value != null && value !== "").length;
    case "ABS": return Math.abs(number(args[0]));
    case "SQRT": {
      const value = number(args[0]);
      if (value < 0) throw new FormulaError("#NUM!");
      return Math.sqrt(value);
    }
    case "ROUND": {
      const digits = Number(args[1] ?? 0);
      const factor = 10 ** digits;
      return Math.round(number(args[0]) * factor) / factor;
    }
    case "INT": return Math.floor(number(args[0]));
    case "MOD": {
      const divisor = number(args[1]);
      if (divisor === 0) throw new FormulaError("#DIV/0!");
      return number(args[0]) % divisor;
    }
    case "POWER": return number(args[0]) ** number(args[1]);
    case "SIGN": return Math.sign(number(args[0]));
    case "IF": return truthy(args[0]) ? args[1] ?? true : args[2] ?? false;
    case "AND": return args.every(truthy);
    case "OR": return args.some(truthy);
    case "NOT": return !truthy(args[0]);
    case "IFERROR":
      try {
        const value = args[0];
        if (value instanceof FormulaError) return args[1] ?? "";
        return value;
      } catch (error) {
        if (error instanceof FormulaError) return args[1] ?? "";
        throw error;
      }
    case "LEN": return display(args[0]).length;
    case "LEFT": return display(args[0]).slice(0, Number(args[1] ?? 1));
    case "RIGHT": {
      const text = display(args[0]);
      return text.slice(Math.max(0, text.length - Number(args[1] ?? 1)));
    }
    case "MID": return display(args[0]).slice(Number(args[1] ?? 1) - 1, Number(args[1] ?? 1) - 1 + Number(args[2] ?? 0));
    case "TRIM": return display(args[0]).trim().replace(/\s+/g, " ");
    case "UPPER": return display(args[0]).toUpperCase();
    case "LOWER": return display(args[0]).toLowerCase();
    case "CONCAT":
    case "CONCATENATE": return args.map(display).join("");
    case "VALUE": return number(args[0]);
    case "ISBLANK": return args[0] == null || args[0] === "";
    case "ISNUMBER": return typeof args[0] === "number";
    case "ISTEXT": return typeof args[0] === "string";
    case "TRUE": return true;
    case "FALSE": return false;
    case "NOW": return Date.now() / 86400000 + 25569;
    case "TODAY": return Math.floor(Date.now() / 86400000) + 25569;
    default: throw new FormulaError("#NAME?", name);
  }
}

function truthy(value: FormulaResult) {
  if (value instanceof FormulaError) throw value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return false;
}

export function evaluateFormula(source: string, lookup: SheetLookup, _visiting = new Set<string>()): FormulaResult {
  try {
    const formula = source.startsWith("=") ? source.slice(1) : source;
    return new Parser(tokenize(formula), lookup).parse();
  } catch (error) {
    if (error instanceof FormulaError) return error;
    return new FormulaError("#VALUE!", error instanceof Error ? error.message : String(error));
  }
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
