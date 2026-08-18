import {
  FormulaError,
  type FormulaArg,
  type FormulaResult,
  type SheetLookup,
  asNumber,
  asText,
  asTruthy,
  flattenGrid,
  numericArgs,
  excelSerialFromYmd,
  ymdFromExcelSerial,
} from "./formula-types";

export type { FormulaArg };

export interface FormulaContext {
  lookup: SheetLookup;
  now: () => Date;
  row: number;
  col: number;
}

type Fn = (args: FormulaArg[], ctx: FormulaContext) => FormulaResult;

const err = (code: string) => new FormulaError(code);

const scalar = (v: FormulaArg): FormulaResult => {
  if (Array.isArray(v)) {
    const first = v[0]?.[0];
    if (first === undefined) throw err("#N/A");
    if (first instanceof FormulaError) throw first;
    return first;
  }
  return v;
};

const to2d = (v: FormulaArg): FormulaResult[][] => {
  if (Array.isArray(v)) return v;
  return [[v]];
};

const flatten = (args: FormulaArg[]): FormulaResult[] => {
  const out: FormulaResult[] = [];
  for (const a of args) out.push(...flattenGrid(a));
  return out;
};

const nums = (args: FormulaArg[]): number[] => numericArgs(flatten(args));

const wildcardRe = (pat: string, caseInsensitive: boolean): RegExp => {
  let body = "";
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === "~" && i + 1 < pat.length) {
      body += pat[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    } else if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`, caseInsensitive ? "i" : "");
};

function parseIndirect(ref: string) {
  const match = /^(?:(?:'([^']+)'|([^'!]+))!)?(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  let col = 0;
  for (const char of match[4].toUpperCase()) {
    if (char < "A" || char > "Z") return null;
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return { sheet: match[1] || match[2] || "", col: col - 1, row: Number(match[6]) - 1 };
}

export const matchCriteria = (value: FormulaResult, criteria: FormulaResult): boolean => {
  if (value instanceof FormulaError) return false;
  const crit = criteria instanceof FormulaError ? String(criteria) : criteria;
  if (typeof crit === "number") {
    return typeof value === "number" && value === crit;
  }
  if (typeof crit === "boolean") {
    return typeof value === "boolean" && value === crit;
  }
  const raw = String(crit);
  const cmp = raw.match(/^(>=|<=|<>|>|<|=)(.*)$/);
  const op = cmp ? cmp[1] : "=";
  const rhsRaw = cmp ? cmp[2] : raw;
  const rhsNum = Number(rhsRaw);
  const rhsIsNum = rhsRaw !== "" && Number.isFinite(rhsNum) && !/[?*~]/.test(rhsRaw);
  if (rhsIsNum && typeof value === "number") {
    if (op === "=") return value === rhsNum;
    if (op === "<>") return value !== rhsNum;
    if (op === ">") return value > rhsNum;
    if (op === "<") return value < rhsNum;
    if (op === ">=") return value >= rhsNum;
    if (op === "<=") return value <= rhsNum;
  }
  const left = String(value);
  const right = rhsRaw;
  const hasWild = /[?*~]/.test(right);
  if (hasWild) {
    const ok = wildcardRe(right, true).test(left);
    return op === "<>" ? !ok : ok;
  }
  const eq = left.toLowerCase() === right.toLowerCase();
  if (op === "=") return eq;
  if (op === "<>") return !eq;
  if (typeof value === "number" && rhsIsNum) return false;
  return false;
};

const rangePair = (
  range: FormulaArg,
  criteria: FormulaArg,
  fn: (cell: FormulaResult, crit: FormulaResult) => boolean,
): { cells: FormulaResult[]; ok: boolean } => {
  const grid = to2d(range);
  const crit = scalar(criteria);
  const cells = flattenGrid(grid);
  return { cells: cells.filter((c) => fn(c, crit)), ok: true };
};

const ROUND = (n: number, d: number, mode: "nearest" | "up" | "down"): number => {
  const f = 10 ** d;
  if (mode === "up") return n >= 0 ? Math.ceil(n * f) / f : Math.floor(n * f) / f;
  if (mode === "down") return n >= 0 ? Math.floor(n * f) / f : Math.ceil(n * f) / f;
  return Math.round(n * f + Number.EPSILON) / f;
};

const lookupInTable = (
  table: FormulaResult[][],
  key: FormulaResult,
  resultCol: number,
  rangeLookup: boolean,
  horizontal: boolean,
): FormulaResult => {
  const rows = horizontal ? (table[0]?.length ?? 0) : table.length;
  const getKey = (i: number) => (horizontal ? table[0]?.[i] : table[i]?.[0]);
  const getVal = (i: number) => {
    if (horizontal) return table[resultCol - 1]?.[i];
    return table[i]?.[resultCol - 1];
  };
  if (resultCol < 1) throw err("#VALUE!");
  if (!rangeLookup) {
    for (let i = 0; i < rows; i += 1) {
      const k = getKey(i);
      if (k === key || String(k).toLowerCase() === String(key).toLowerCase()) {
        const v = getVal(i);
        if (v === undefined) throw err("#REF!");
        return v;
      }
    }
    throw err("#N/A");
  }
  let last: FormulaResult | undefined;
  for (let i = 0; i < rows; i += 1) {
    const k = getKey(i);
    if (typeof k === "number" && typeof key === "number") {
      if (k <= key) last = getVal(i);
      else break;
    } else if (String(k).toLowerCase() <= String(key).toLowerCase()) last = getVal(i);
    else break;
  }
  if (last === undefined) throw err("#N/A");
  return last;
};

const FUNCTIONS: Record<string, Fn> = {
  SUM: (args) => nums(args).reduce((a, b) => a + b, 0),
  AVERAGE: (args) => {
    const n = nums(args);
    if (!n.length) throw err("#DIV/0!");
    return n.reduce((a, b) => a + b, 0) / n.length;
  },
  MIN: (args) => {
    const n = nums(args);
    if (!n.length) return 0;
    return Math.min(...n);
  },
  MAX: (args) => {
    const n = nums(args);
    if (!n.length) return 0;
    return Math.max(...n);
  },
  COUNT: (args) => nums(args).length,
  COUNTA: (args) => flatten(args).filter((v) => v != null && v !== "").length,
  COUNTBLANK: (args) => flatten(args).filter((v) => v === "").length,
  PRODUCT: (args) => nums(args).reduce((a, b) => a * b, 1),
  ABS: (args) => Math.abs(asNumber(scalar(args[0]))),
  ROUND: (args) => ROUND(asNumber(scalar(args[0])), Math.trunc(asNumber(scalar(args[1] ?? 0))), "nearest"),
  ROUNDUP: (args) => ROUND(asNumber(scalar(args[0])), Math.trunc(asNumber(scalar(args[1] ?? 0))), "up"),
  ROUNDDOWN: (args) => ROUND(asNumber(scalar(args[0])), Math.trunc(asNumber(scalar(args[1] ?? 0))), "down"),
  INT: (args) => Math.floor(asNumber(scalar(args[0]))),
  TRUNC: (args) => {
    const n = asNumber(scalar(args[0]));
    const d = Math.trunc(asNumber(scalar(args[1] ?? 0)));
    const f = 10 ** d;
    return (n < 0 ? Math.ceil(n * f) : Math.floor(n * f)) / f;
  },
  CEILING: (args) => {
    const n = asNumber(scalar(args[0]));
    const sig = asNumber(scalar(args[1] ?? 1)) || 1;
    return Math.ceil(n / sig) * sig;
  },
  FLOOR: (args) => {
    const n = asNumber(scalar(args[0]));
    const sig = asNumber(scalar(args[1] ?? 1)) || 1;
    return Math.floor(n / sig) * sig;
  },
  MOD: (args) => {
    const n = asNumber(scalar(args[0]));
    const d = asNumber(scalar(args[1]));
    if (d === 0) throw err("#DIV/0!");
    return n - d * Math.floor(n / d);
  },
  POWER: (args) => asNumber(scalar(args[0])) ** asNumber(scalar(args[1])),
  SQRT: (args) => {
    const n = asNumber(scalar(args[0]));
    if (n < 0) throw err("#NUM!");
    return Math.sqrt(n);
  },
  LN: (args) => {
    const n = asNumber(scalar(args[0]));
    if (n <= 0) throw err("#NUM!");
    return Math.log(n);
  },
  LOG: (args) => {
    const n = asNumber(scalar(args[0]));
    const b = asNumber(scalar(args[1] ?? 10));
    if (n <= 0 || b <= 0 || b === 1) throw err("#NUM!");
    return Math.log(n) / Math.log(b);
  },
  LOG10: (args) => {
    const n = asNumber(scalar(args[0]));
    if (n <= 0) throw err("#NUM!");
    return Math.log10(n);
  },
  EXP: (args) => Math.exp(asNumber(scalar(args[0]))),
  PI: () => Math.PI,
  SIGN: (args) => Math.sign(asNumber(scalar(args[0]))),
  RAND: () => Math.random(),
  IF: (args) => (asTruthy(scalar(args[0])) ? scalar(args[1] ?? true) : scalar(args[2] ?? false)),
  IFERROR: (args) => {
    try {
      const v = scalar(args[0]);
      if (v instanceof FormulaError) return scalar(args[1] ?? "");
      return v;
    } catch (e) {
      if (e instanceof FormulaError) return scalar(args[1] ?? "");
      throw e;
    }
  },
  IFNA: (args) => {
    const v = scalar(args[0]);
    if (v instanceof FormulaError && v.code === "#N/A") return scalar(args[1] ?? "");
    return v;
  },
  AND: (args) => flatten(args).every(asTruthy),
  OR: (args) => flatten(args).some(asTruthy),
  NOT: (args) => !asTruthy(scalar(args[0])),
  TRUE: () => true,
  FALSE: () => false,
  ISBLANK: (args) => scalar(args[0]) === "",
  ISNUMBER: (args) => typeof scalar(args[0]) === "number",
  ISTEXT: (args) => typeof scalar(args[0]) === "string" && scalar(args[0]) !== "",
  ISERROR: (args) => {
    try {
      return scalar(args[0]) instanceof FormulaError;
    } catch (e) {
      return e instanceof FormulaError;
    }
  },
  ISNA: (args) => {
    try {
      const v = scalar(args[0]);
      return v instanceof FormulaError && v.code === "#N/A";
    } catch (e) {
      return e instanceof FormulaError && e.code === "#N/A";
    }
  },
  N: (args) => {
    const v = scalar(args[0]);
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return 0;
  },
  LEN: (args) => asText(scalar(args[0])).length,
  LEFT: (args) => asText(scalar(args[0])).slice(0, Math.max(0, Math.trunc(asNumber(scalar(args[1] ?? 1))))),
  RIGHT: (args) => {
    const t = asText(scalar(args[0]));
    const n = Math.max(0, Math.trunc(asNumber(scalar(args[1] ?? 1))));
    return t.slice(-n);
  },
  MID: (args) => {
    const t = asText(scalar(args[0]));
    const start = Math.max(1, Math.trunc(asNumber(scalar(args[1])))) - 1;
    const n = Math.max(0, Math.trunc(asNumber(scalar(args[2]))));
    return t.slice(start, start + n);
  },
  TRIM: (args) => asText(scalar(args[0])).replace(/\s+/g, " ").trim(),
  UPPER: (args) => asText(scalar(args[0])).toUpperCase(),
  LOWER: (args) => asText(scalar(args[0])).toLowerCase(),
  PROPER: (args) =>
    asText(scalar(args[0])).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
  CONCAT: (args) => flatten(args).map(asText).join(""),
  CONCATENATE: (args) => flatten(args).map(asText).join(""),
  TEXTJOIN: (args) => {
    const delim = asText(scalar(args[0]));
    const ignoreEmpty = asTruthy(scalar(args[1] ?? true));
    const parts = flatten(args.slice(2)).map(asText).filter((s) => (ignoreEmpty ? s !== "" : true));
    return parts.join(delim);
  },
  VALUE: (args) => asNumber(scalar(args[0])),
  FIND: (args) => {
    const needle = asText(scalar(args[0]));
    const hay = asText(scalar(args[1]));
    const start = Math.max(1, Math.trunc(asNumber(scalar(args[2] ?? 1)))) - 1;
    const i = hay.indexOf(needle, start);
    if (i < 0) throw err("#VALUE!");
    return i + 1;
  },
  SEARCH: (args) => {
    const needle = asText(scalar(args[0])).toLowerCase();
    const hay = asText(scalar(args[1])).toLowerCase();
    const start = Math.max(1, Math.trunc(asNumber(scalar(args[2] ?? 1)))) - 1;
    const i = hay.indexOf(needle, start);
    if (i < 0) throw err("#VALUE!");
    return i + 1;
  },
  SUBSTITUTE: (args) => {
    const text = asText(scalar(args[0]));
    const oldS = asText(scalar(args[1]));
    const newS = asText(scalar(args[2]));
    const nth = args[3] === undefined ? 0 : Math.trunc(asNumber(scalar(args[3])));
    if (!nth) return text.split(oldS).join(newS);
    let seen = 0;
    return text.replaceAll(oldS, (m) => {
      seen += 1;
      return seen === nth ? newS : m;
    });
  },
  REPLACE: (args) => {
    const text = asText(scalar(args[0]));
    const start = Math.max(1, Math.trunc(asNumber(scalar(args[1])))) - 1;
    const n = Math.max(0, Math.trunc(asNumber(scalar(args[2]))));
    const ins = asText(scalar(args[3]));
    return text.slice(0, start) + ins + text.slice(start + n);
  },
  REPT: (args) => asText(scalar(args[0])).repeat(Math.max(0, Math.trunc(asNumber(scalar(args[1]))))),
  EXACT: (args) => asText(scalar(args[0])) === asText(scalar(args[1])),
  CHAR: (args) => String.fromCharCode(Math.trunc(asNumber(scalar(args[0])))),
  CODE: (args) => asText(scalar(args[0])).charCodeAt(0) || 0,
  TODAY: (_a, ctx) => {
    const d = ctx.now();
    return excelSerialFromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  },
  NOW: (_a, ctx) => {
    const d = ctx.now();
    const serial = excelSerialFromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return serial + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  },
  DATE: (args) =>
    excelSerialFromYmd(
      Math.trunc(asNumber(scalar(args[0]))),
      Math.trunc(asNumber(scalar(args[1]))),
      Math.trunc(asNumber(scalar(args[2]))),
    ),
  YEAR: (args) => ymdFromExcelSerial(asNumber(scalar(args[0]))).y,
  MONTH: (args) => ymdFromExcelSerial(asNumber(scalar(args[0]))).m,
  DAY: (args) => ymdFromExcelSerial(asNumber(scalar(args[0]))).d,
  WEEKDAY: (args) => {
    const { y, m, d } = ymdFromExcelSerial(asNumber(scalar(args[0])));
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun
    const type = Math.trunc(asNumber(scalar(args[1] ?? 1)));
    if (type === 1) return wd + 1;
    if (type === 2) return wd === 0 ? 7 : wd;
    if (type === 3) return wd === 0 ? 6 : wd - 1;
    return wd + 1;
  },
  TEXT: (args) => {
    const v = scalar(args[0]);
    const fmt = asText(scalar(args[1] ?? "General"));
    if (typeof v !== "number") return asText(v);
    if (fmt === "0" || fmt === "General") return String(Math.round(v));
    const m = fmt.match(/^0\.(0+)$/);
    if (m) return v.toFixed(m[1].length);
    if (fmt === "yyyy-mm-dd" || fmt === "YYYY-MM-DD") {
      const { y, m: mo, d } = ymdFromExcelSerial(v);
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return String(v);
  },
  NA: () => {
    throw err("#N/A");
  },
  CHOOSE: (args) => {
    const i = Math.trunc(asNumber(scalar(args[0])));
    if (i < 1 || i >= args.length) throw err("#VALUE!");
    return scalar(args[i]);
  },
  COLUMN: (args, ctx) => {
    if (args[0] !== undefined && Array.isArray(args[0])) return 1;
    return ctx.col + 1;
  },
  ROW: (args, ctx) => {
    if (args[0] !== undefined && Array.isArray(args[0])) return 1;
    return ctx.row + 1;
  },
  COLUMNS: (args) => to2d(args[0])[0]?.length ?? 0,
  ROWS: (args) => to2d(args[0]).length,
  LARGE: (args) => {
    const n = nums([args[0]]).sort((a, b) => b - a);
    const k = Math.trunc(asNumber(scalar(args[1])));
    if (k < 1 || k > n.length) throw err("#NUM!");
    return n[k - 1];
  },
  SMALL: (args) => {
    const n = nums([args[0]]).sort((a, b) => a - b);
    const k = Math.trunc(asNumber(scalar(args[1])));
    if (k < 1 || k > n.length) throw err("#NUM!");
    return n[k - 1];
  },
  MEDIAN: (args) => {
    const n = nums(args).sort((a, b) => a - b);
    if (!n.length) throw err("#NUM!");
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  SUMPRODUCT: (args) => {
    const grids = args.map(to2d);
    const r = Math.max(...grids.map((g) => g.length));
    const c = Math.max(...grids.map((g) => g[0]?.length ?? 0));
    let sum = 0;
    for (let i = 0; i < r; i += 1) {
      for (let j = 0; j < c; j += 1) {
        let p = 1;
        for (const g of grids) {
          const v = g[i]?.[j];
          p *= typeof v === "number" ? v : 0;
        }
        sum += p;
      }
    }
    return sum;
  },
  COUNTIF: (args) => rangePair(args[0], args[1], matchCriteria).cells.length,
  SUMIF: (args) => {
    const grid = to2d(args[0]);
    const sumGrid = args[2] !== undefined ? to2d(args[2]) : grid;
    const crit = scalar(args[1]);
    const cells = flattenGrid(grid);
    const sums = flattenGrid(sumGrid);
    let total = 0;
    cells.forEach((c, i) => {
      if (matchCriteria(c, crit)) {
        const s = sums[i];
        if (typeof s === "number") total += s;
      }
    });
    return total;
  },
  AVERAGEIF: (args) => {
    const grid = to2d(args[0]);
    const avgGrid = args[2] !== undefined ? to2d(args[2]) : grid;
    const crit = scalar(args[1]);
    const cells = flattenGrid(grid);
    const avgs = flattenGrid(avgGrid);
    let total = 0;
    let n = 0;
    cells.forEach((c, i) => {
      if (matchCriteria(c, crit) && typeof avgs[i] === "number") {
        total += avgs[i] as number;
        n += 1;
      }
    });
    if (!n) throw err("#DIV/0!");
    return total / n;
  },
  COUNTIFS: (args) => {
    if (args.length < 2 || args.length % 2) throw err("#VALUE!");
    const grids: Array<{ cells: FormulaResult[]; crit: FormulaResult }> = [];
    for (let i = 0; i < args.length; i += 2) {
      grids.push({ cells: flattenGrid(to2d(args[i])), crit: scalar(args[i + 1]) });
    }
    const len = grids[0].cells.length;
    let n = 0;
    for (let i = 0; i < len; i += 1) {
      if (grids.every((g) => matchCriteria(g.cells[i], g.crit))) n += 1;
    }
    return n;
  },
  SUMIFS: (args) => {
    if (args.length < 3 || args.length % 2 === 0) throw err("#VALUE!");
    const sumCells = flattenGrid(to2d(args[0]));
    const grids: Array<{ cells: FormulaResult[]; crit: FormulaResult }> = [];
    for (let i = 1; i < args.length; i += 2) {
      grids.push({ cells: flattenGrid(to2d(args[i])), crit: scalar(args[i + 1]) });
    }
    let total = 0;
    for (let i = 0; i < sumCells.length; i += 1) {
      if (grids.every((g) => matchCriteria(g.cells[i], g.crit))) {
        const s = sumCells[i];
        if (typeof s === "number") total += s;
      }
    }
    return total;
  },
  VLOOKUP: (args) =>
    lookupInTable(
      to2d(args[1]),
      scalar(args[0]),
      Math.trunc(asNumber(scalar(args[2]))),
      args[3] === undefined ? true : asTruthy(scalar(args[3])),
      false,
    ),
  HLOOKUP: (args) =>
    lookupInTable(
      to2d(args[1]),
      scalar(args[0]),
      Math.trunc(asNumber(scalar(args[2]))),
      args[3] === undefined ? true : asTruthy(scalar(args[3])),
      true,
    ),
  INDEX: (args) => {
    const grid = to2d(args[0]);
    const r = Math.trunc(asNumber(scalar(args[1] ?? 1)));
    const c = Math.trunc(asNumber(scalar(args[2] ?? 1)));
    const v = grid[r - 1]?.[c - 1];
    if (v === undefined) throw err("#REF!");
    return v;
  },
  MATCH: (args) => {
    const key = scalar(args[0]);
    const list = flattenGrid(to2d(args[1]));
    const type = Math.trunc(asNumber(scalar(args[2] ?? 1)));
    if (type === 0) {
      const i = list.findIndex(
        (v) => v === key || String(v).toLowerCase() === String(key).toLowerCase(),
      );
      if (i < 0) throw err("#N/A");
      return i + 1;
    }
    if (type === 1) {
      let last = -1;
      for (let i = 0; i < list.length; i += 1) {
        const v = list[i];
        if (typeof v === "number" && typeof key === "number") {
          if (v <= key) last = i;
          else break;
        } else if (String(v).toLowerCase() <= String(key).toLowerCase()) last = i;
        else break;
      }
      if (last < 0) throw err("#N/A");
      return last + 1;
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const v = list[i];
      if (typeof v === "number" && typeof key === "number" && v >= key) return i + 1;
    }
    throw err("#N/A");
  },
  IFS: (args) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (asTruthy(scalar(args[i]))) return scalar(args[i + 1]);
    }
    throw err("#N/A");
  },
  SWITCH: (args) => {
    const expr = scalar(args[0]);
    for (let i = 1; i + 1 < args.length; i += 2) {
      if (scalar(args[i]) === expr || String(scalar(args[i])).toLowerCase() === String(expr).toLowerCase()) return scalar(args[i + 1]);
    }
    if (args.length % 2 === 0) return scalar(args[args.length - 1]);
    throw err("#N/A");
  },
  XOR: (args) => flatten(args).map(asTruthy).filter(Boolean).length % 2 === 1,
  MAXIFS: (args) => {
    const maxCells = flattenGrid(to2d(args[0]));
    const grids: Array<{ cells: FormulaResult[]; crit: FormulaResult }> = [];
    for (let i = 1; i < args.length; i += 2) grids.push({ cells: flattenGrid(to2d(args[i])), crit: scalar(args[i + 1]) });
    const values = maxCells.filter((cell, i) => typeof cell === "number" && grids.every((g) => matchCriteria(g.cells[i], g.crit))) as number[];
    if (!values.length) throw err("#N/A");
    return Math.max(...values);
  },
  MINIFS: (args) => {
    const minCells = flattenGrid(to2d(args[0]));
    const grids: Array<{ cells: FormulaResult[]; crit: FormulaResult }> = [];
    for (let i = 1; i < args.length; i += 2) grids.push({ cells: flattenGrid(to2d(args[i])), crit: scalar(args[i + 1]) });
    const values = minCells.filter((cell, i) => typeof cell === "number" && grids.every((g) => matchCriteria(g.cells[i], g.crit))) as number[];
    if (!values.length) throw err("#N/A");
    return Math.min(...values);
  },
  AVERAGEIFS: (args) => {
    const avgCells = flattenGrid(to2d(args[0]));
    const grids: Array<{ cells: FormulaResult[]; crit: FormulaResult }> = [];
    for (let i = 1; i < args.length; i += 2) grids.push({ cells: flattenGrid(to2d(args[i])), crit: scalar(args[i + 1]) });
    let total = 0;
    let n = 0;
    avgCells.forEach((cell, i) => {
      if (typeof cell === "number" && grids.every((g) => matchCriteria(g.cells[i], g.crit))) {
        total += cell;
        n += 1;
      }
    });
    if (!n) throw err("#DIV/0!");
    return total / n;
  },
  RANK: (args) => {
    const value = asNumber(scalar(args[0]));
    const list = nums([args[1]]).sort((a, b) => b - a);
    const order = asNumber(scalar(args[2] ?? 0));
    const ranked = order ? [...list].sort((a, b) => a - b) : list;
    const i = ranked.indexOf(value);
    if (i < 0) throw err("#N/A");
    return i + 1;
  },
  STDEV: (args) => {
    const n = nums(args);
    if (n.length < 2) throw err("#DIV/0!");
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1));
  },
  STDEVP: (args) => {
    const n = nums(args);
    if (!n.length) throw err("#DIV/0!");
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length);
  },
  VAR: (args) => {
    const n = nums(args);
    if (n.length < 2) throw err("#DIV/0!");
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1);
  },
  VARP: (args) => {
    const n = nums(args);
    if (!n.length) throw err("#DIV/0!");
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length;
  },
  PMT: (args) => {
    const rate = asNumber(scalar(args[0]));
    const nper = asNumber(scalar(args[1]));
    const pv = asNumber(scalar(args[2]));
    const fv = asNumber(scalar(args[3] ?? 0));
    const type = asNumber(scalar(args[4] ?? 0));
    if (rate === 0) return -(pv + fv) / nper;
    const pow = (1 + rate) ** nper;
    return -(pv * pow + fv) * rate / ((1 + rate * type) * (pow - 1));
  },
  FV: (args) => {
    const rate = asNumber(scalar(args[0]));
    const nper = asNumber(scalar(args[1]));
    const pmt = asNumber(scalar(args[2]));
    const pv = asNumber(scalar(args[3] ?? 0));
    const type = asNumber(scalar(args[4] ?? 0));
    if (rate === 0) return -pv - pmt * nper;
    const pow = (1 + rate) ** nper;
    return -pv * pow - pmt * (1 + rate * type) * (pow - 1) / rate;
  },
  PV: (args) => {
    const rate = asNumber(scalar(args[0]));
    const nper = asNumber(scalar(args[1]));
    const pmt = asNumber(scalar(args[2]));
    const fv = asNumber(scalar(args[3] ?? 0));
    const type = asNumber(scalar(args[4] ?? 0));
    if (rate === 0) return -fv - pmt * nper;
    const pow = (1 + rate) ** nper;
    return (-fv - pmt * (1 + rate * type) * (pow - 1) / rate) / pow;
  },
  NPV: (args) => {
    const rate = asNumber(scalar(args[0]));
    return flatten(args.slice(1)).reduce<number>((sum, value, index) => {
      if (typeof value !== "number") return sum;
      return sum + value / (1 + rate) ** (index + 1);
    }, 0);
  },
  NPER: (args) => {
    const rate = asNumber(scalar(args[0]));
    const pmt = asNumber(scalar(args[1]));
    const pv = asNumber(scalar(args[2]));
    const fv = asNumber(scalar(args[3] ?? 0));
    const type = asNumber(scalar(args[4] ?? 0));
    if (rate === 0) return -(pv + fv) / pmt;
    return Math.log((pmt * (1 + rate * type) / rate - fv) / (pv + pmt * (1 + rate * type) / rate)) / Math.log(1 + rate);
  },
  EDATE: (args) => {
    const { y, m, d } = ymdFromExcelSerial(asNumber(scalar(args[0])));
    return excelSerialFromYmd(y, m + Math.trunc(asNumber(scalar(args[1]))), d);
  },
  EOMONTH: (args) => {
    const { y, m } = ymdFromExcelSerial(asNumber(scalar(args[0])));
    const months = Math.trunc(asNumber(scalar(args[1])));
    return excelSerialFromYmd(y, m + months + 1, 0);
  },
  DAYS: (args) => asNumber(scalar(args[0])) - asNumber(scalar(args[1])),
  DATEDIF: (args) => {
    const start = asNumber(scalar(args[0]));
    const end = asNumber(scalar(args[1]));
    const unit = asText(scalar(args[2])).toUpperCase();
    const a = ymdFromExcelSerial(start);
    const b = ymdFromExcelSerial(end);
    if (unit === "D") return end - start;
    if (unit === "M") return (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0);
    if (unit === "Y") return b.y - a.y - (b.m < a.m || (b.m === a.m && b.d < a.d) ? 1 : 0);
    return end - start;
  },
  HOUR: (args) => Math.floor((asNumber(scalar(args[0])) % 1) * 24),
  MINUTE: (args) => Math.floor((asNumber(scalar(args[0])) * 1440) % 60),
  SECOND: (args) => Math.floor((asNumber(scalar(args[0])) * 86400) % 60),
  TIME: (args) => (asNumber(scalar(args[0])) * 3600 + asNumber(scalar(args[1])) * 60 + asNumber(scalar(args[2]))) / 86400,
  NETWORKDAYS: (args) => {
    const start = Math.trunc(asNumber(scalar(args[0])));
    const end = Math.trunc(asNumber(scalar(args[1])));
    let n = 0;
    for (let serial = Math.min(start, end); serial <= Math.max(start, end); serial += 1) {
      const wd = ymdFromExcelSerial(serial);
      const day = new Date(Date.UTC(wd.y, wd.m - 1, wd.d)).getUTCDay();
      if (day !== 0 && day !== 6) n += 1;
    }
    return n;
  },
  SIN: (args) => Math.sin(asNumber(scalar(args[0]))),
  COS: (args) => Math.cos(asNumber(scalar(args[0]))),
  TAN: (args) => Math.tan(asNumber(scalar(args[0]))),
  ASIN: (args) => Math.asin(asNumber(scalar(args[0]))),
  ACOS: (args) => Math.acos(asNumber(scalar(args[0]))),
  ATAN: (args) => Math.atan(asNumber(scalar(args[0]))),
  DEGREES: (args) => asNumber(scalar(args[0])) * (180 / Math.PI),
  RADIANS: (args) => asNumber(scalar(args[0])) * (Math.PI / 180),
  FACT: (args) => {
    const n = Math.trunc(asNumber(scalar(args[0])));
    if (n < 0) throw err("#NUM!");
    let r = 1;
    for (let i = 2; i <= n; i += 1) r *= i;
    return r;
  },
  GCD: (args) => {
    const values = nums(args).map((n) => Math.abs(Math.trunc(n)));
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    return values.reduce((a, b) => gcd(a, b), values[0] ?? 0);
  },
  LCM: (args) => {
    const values = nums(args).map((n) => Math.abs(Math.trunc(n)));
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    return values.reduce((a, b) => a * b / gcd(a, b), 1);
  },
  EVEN: (args) => {
    const n = asNumber(scalar(args[0]));
    const sign = n < 0 ? -1 : 1;
    const up = Math.ceil(Math.abs(n));
    return sign * (up % 2 === 0 ? up : up + 1);
  },
  ODD: (args) => {
    const n = asNumber(scalar(args[0]));
    const sign = n < 0 ? -1 : 1;
    const up = Math.ceil(Math.abs(n));
    return sign * (up % 2 === 1 ? up : up + 1);
  },
  COMBIN: (args) => {
    const n = Math.trunc(asNumber(scalar(args[0])));
    const k = Math.trunc(asNumber(scalar(args[1])));
    if (k < 0 || k > n) throw err("#NUM!");
    let r = 1;
    for (let i = 1; i <= k; i += 1) r = r * (n - k + i) / i;
    return Math.round(r);
  },
  FIXED: (args) => asNumber(scalar(args[0])).toFixed(Math.trunc(asNumber(scalar(args[1] ?? 2)))),
  DOLLAR: (args) => `$${asNumber(scalar(args[0])).toFixed(Math.trunc(asNumber(scalar(args[1] ?? 2))))}`,
  T: (args) => (typeof scalar(args[0]) === "string" ? scalar(args[0]) : ""),
  HYPERLINK: (args) => asText(scalar(args[1] ?? args[0])),
  RANDBETWEEN: (args) => {
    const min = Math.ceil(asNumber(scalar(args[0])));
    const max = Math.floor(asNumber(scalar(args[1])));
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },
  QUOTIENT: (args) => Math.trunc(asNumber(scalar(args[0])) / asNumber(scalar(args[1]))),
  ISEVEN: (args) => Math.trunc(asNumber(scalar(args[0]))) % 2 === 0,
  ISODD: (args) => Math.trunc(asNumber(scalar(args[0]))) % 2 !== 0,
  UNIQUE: (args) => {
    const seen = new Set<string>();
    let n = 0;
    for (const value of flatten(args)) {
      const key = String(value);
      if (!seen.has(key)) {
        seen.add(key);
        n += 1;
      }
    }
    return n;
  },
  LOOKUP: (args) => {
    const key = scalar(args[0]);
    const list = flattenGrid(to2d(args[1]));
    const result = args[2] !== undefined ? flattenGrid(to2d(args[2])) : list;
    let last = -1;
    for (let i = 0; i < list.length; i += 1) {
      const v = list[i];
      if (typeof v === "number" && typeof key === "number") {
        if (v <= key) last = i;
        else break;
      } else if (String(v).toLowerCase() <= String(key).toLowerCase()) last = i;
      else break;
    }
    if (last < 0) throw err("#N/A");
    const found = result[last];
    if (found === undefined) throw err("#N/A");
    return found;
  },
  XLOOKUP: (args) => {
    const key = scalar(args[0]);
    const lookup = flattenGrid(to2d(args[1]));
    const result = flattenGrid(to2d(args[2]));
    const i = lookup.findIndex((v) => v === key || String(v).toLowerCase() === String(key).toLowerCase());
    if (i < 0) {
      if (args[3] !== undefined) return scalar(args[3]);
      throw err("#N/A");
    }
    const found = result[i];
    if (found === undefined) throw err("#N/A");
    return found;
  },
  INDIRECT: (args, ctx) => {
    const ref = parseIndirect(asText(scalar(args[0])));
    if (!ref) throw err("#REF!");
    const lookup = ref.sheet ? ctx.lookup.getSheet?.(ref.sheet) : ctx.lookup;
    if (!lookup) throw err("#REF!");
    return lookup.getCell(ref.row, ref.col);
  },
};

FUNCTIONS["RANK.EQ"] = FUNCTIONS.RANK;
FUNCTIONS["STDEV.S"] = FUNCTIONS.STDEV;
FUNCTIONS["STDEV.P"] = FUNCTIONS.STDEVP;
FUNCTIONS["VAR.S"] = FUNCTIONS.VAR;
FUNCTIONS["VAR.P"] = FUNCTIONS.VARP;
FUNCTIONS["CONCATENATE"] = FUNCTIONS.CONCAT;

export const callFunction = (
  name: string,
  args: FormulaArg[],
  ctx: FormulaContext,
): FormulaResult => {
  const fn = FUNCTIONS[name.toUpperCase()];
  if (!fn) throw err("#NAME?");
  return fn(args, ctx);
};

export const supportedFunctionNames = (): string[] => Object.keys(FUNCTIONS).sort();
