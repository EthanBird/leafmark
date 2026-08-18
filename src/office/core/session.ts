import { LambdaCommand, UndoStack } from "./command";
import { isPresentation, isWord, isWorkbook, openOfficeModel, serializeOfficeModel, type OfficeModel } from "./codec";
import {
  applyParagraphStyle,
  deleteWordBlock,
  insertWordBlock,
  replaceWordBlock,
  splitParagraph,
  type WordBlock,
  type WordParagraph,
} from "../word";
import {
  addSheet,
  copyRange,
  deleteCols,
  deleteRows,
  editCell,
  fillDown,
  getCellInput,
  insertCols,
  insertRows,
  pasteRange,
  readViewport,
  type WorkbookModel,
} from "../sheet";
import {
  addBlankSlide,
  deleteShape,
  deleteSlide,
  duplicateSlide,
  setSlideBackground,
  updateShapeStyle,
  updateShapeText,
  type PresentationDocument,
  type SlideModel,
} from "../slide";
import {
  SHEET_INITIAL_COLS,
  SHEET_INITIAL_ROWS,
  WORD_INITIAL_BLOCKS,
  type OfficeKind,
  type OfficeMutation,
  type OfficeOpenResult,
} from "../types";

export class OfficeSession {
  readonly undo = new UndoStack();
  readonly model: OfficeModel;
  readonly kind: OfficeKind;
  readonly format: string;

  constructor(kind: OfficeKind, format: string, model: OfficeModel) {
    this.kind = kind;
    this.format = format;
    this.model = model;
  }

  static open(kind: OfficeKind, format: string, buffer: ArrayBuffer) {
    const opened = openOfficeModel(kind, format, buffer);
    if (opened.type === "compatibility") return opened;
    return new OfficeSession(kind, format, opened);
  }

  snapshot(firstPaintMs = 0): OfficeOpenResult {
    if (isWord(this.model)) {
      return {
        type: "word",
        editable: true,
        blocks: this.model.blocks.slice(0, WORD_INITIAL_BLOCKS),
        totalBlocks: this.model.blocks.length,
        firstPaintMs,
      };
    }
    if (isWorkbook(this.model)) {
      const first = this.model.sheets[0];
      return {
        type: "spreadsheet",
        editable: this.model.editable,
        sheets: this.model.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows, cols: sheet.cols })),
        active: first ? readViewport(this.model, first.name, 0, SHEET_INITIAL_ROWS, 0, Math.max(SHEET_INITIAL_COLS, first.cols)) : null,
        firstPaintMs,
      };
    }
    return {
      type: "presentation",
      editable: this.model.editable,
      slides: this.model.slides.map((slide) => ({ index: slide.index, title: slide.title })),
      active: this.model.slides[0] ?? null,
      firstPaintMs,
    };
  }

  serialize() {
    return serializeOfficeModel(this.model);
  }

  mutate(mutation: OfficeMutation) {
    this.undo.execute(new LambdaCommand(mutation.op, () => this.apply(mutation, false), () => this.apply(mutation, true)));
    return this.resultOf(mutation);
  }

  undoOnce() {
    return this.undo.undo();
  }

  redoOnce() {
    return this.undo.redo();
  }

  private apply(mutation: OfficeMutation, reversing: boolean) {
    if (mutation.op.startsWith("word")) this.applyWord(mutation, reversing);
    else if (mutation.op.startsWith("sheet")) this.applySheet(mutation, reversing);
    else this.applySlide(mutation, reversing);
  }

  private wordDoc() {
    if (!isWord(this.model)) throw new Error("当前文档不是 Word 文档");
    return this.model;
  }

  private book() {
    if (!isWorkbook(this.model)) throw new Error("当前文档不是电子表格");
    return this.model;
  }

  private deck() {
    if (!isPresentation(this.model)) throw new Error("当前文档不是演示文稿");
    return this.model;
  }

  private applyWord(mutation: OfficeMutation, reversing: boolean) {
    const document = this.wordDoc();
    if (mutation.op === "wordReplace") {
      const current = document.blocks[mutation.index];
      (mutation as OfficeMutation & { _prev?: WordBlock })._prev ??= structuredClone(current);
      if (reversing) document.blocks[mutation.index] = structuredClone((mutation as OfficeMutation & { _prev?: WordBlock })._prev as WordBlock);
      else replaceWordBlock(document, mutation.index, mutation.block);
      return;
    }
    if (mutation.op === "wordInsert") {
      if (reversing) deleteWordBlock(document, mutation.index);
      else insertWordBlock(document, mutation.index, mutation.block);
      return;
    }
    if (mutation.op === "wordDelete") {
      const bag = mutation as OfficeMutation & { _prev?: WordBlock };
      bag._prev ??= structuredClone(document.blocks[mutation.index]);
      if (reversing && bag._prev) insertWordBlock(document, mutation.index, bag._prev);
      else deleteWordBlock(document, mutation.index);
      return;
    }
    if (mutation.op === "wordSplit") {
      const block = document.blocks[mutation.index];
      if (block.kind === "table") return;
      if (reversing) {
        const right = document.blocks[mutation.index + 1];
        if (right && right.kind !== "table") {
          block.runs = [...block.runs, ...right.runs];
          block.dirty = true;
          deleteWordBlock(document, mutation.index + 1);
        }
        return;
      }
      const [left, right] = splitParagraph(block, mutation.offset);
      document.blocks[mutation.index] = left;
      insertWordBlock(document, mutation.index + 1, right);
      return;
    }
    if (mutation.op === "wordStyle") {
      const block = document.blocks[mutation.index];
      if (block.kind === "table") return;
      const bag = mutation as OfficeMutation & { _prev?: WordParagraph };
      bag._prev ??= structuredClone(block);
      if (reversing && bag._prev) document.blocks[mutation.index] = structuredClone(bag._prev);
      else document.blocks[mutation.index] = applyParagraphStyle(block, mutation.patch);
    }
  }

  private applySheet(mutation: OfficeMutation, reversing: boolean) {
    const book = this.book();
    if (mutation.op === "sheetEdit") {
      const sheet = book.sheets.find((item) => item.name === mutation.name);
      if (!sheet) return;
      const bag = mutation as OfficeMutation & { _prev?: string };
      bag._prev ??= getCellInput(sheet, mutation.row, mutation.col);
      editCell(book, mutation.name, mutation.row, mutation.col, reversing ? bag._prev : mutation.input);
      return;
    }
    if (mutation.op === "sheetAdd") {
      const bag = mutation as OfficeMutation & { _name?: string };
      if (reversing) {
        const name = bag._name;
        if (name) book.sheets.splice(book.sheets.findIndex((sheet) => sheet.name === name), 1);
        return;
      }
      bag._name = addSheet(book, mutation.name);
      return;
    }
    if (mutation.op === "sheetInsert") {
      const count = mutation.count ?? 1;
      if (reversing) {
        if (mutation.axis === "row") deleteRows(book, mutation.name, mutation.index, count);
        else deleteCols(book, mutation.name, mutation.index, count);
        return;
      }
      if (mutation.axis === "row") insertRows(book, mutation.name, mutation.index, count);
      else insertCols(book, mutation.name, mutation.index, count);
      return;
    }
    if (mutation.op === "sheetDelete") {
      const count = mutation.count ?? 1;
      const bag = mutation as OfficeMutation & { _values?: string[][] };
      if (!reversing) {
        const sheet = book.sheets.find((item) => item.name === mutation.name);
        const rowCount = mutation.axis === "row" ? count : Math.max(1, sheet?.rows ?? 1);
        const colCount = mutation.axis === "col" ? count : Math.max(1, sheet?.cols ?? 1);
        const row = mutation.axis === "row" ? mutation.index : 0;
        const col = mutation.axis === "col" ? mutation.index : 0;
        bag._values = copyRange(book, mutation.name, row, col, rowCount, colCount);
        if (mutation.axis === "row") deleteRows(book, mutation.name, mutation.index, count);
        else deleteCols(book, mutation.name, mutation.index, count);
        return;
      }
      if (mutation.axis === "row") insertRows(book, mutation.name, mutation.index, count);
      else insertCols(book, mutation.name, mutation.index, count);
      if (bag._values) {
        const row = mutation.axis === "row" ? mutation.index : 0;
        const col = mutation.axis === "col" ? mutation.index : 0;
        pasteRange(book, mutation.name, row, col, bag._values);
      }
      return;
    }
    if (mutation.op === "sheetFill") {
      const bag = mutation as OfficeMutation & { _values?: string[][] };
      bag._values ??= copyRange(book, mutation.name, mutation.row, mutation.col, mutation.rowCount, mutation.colCount);
      if (reversing) pasteRange(book, mutation.name, mutation.row, mutation.col, bag._values);
      else fillDown(book, mutation.name, mutation.row, mutation.col, mutation.rowCount, mutation.colCount);
      return;
    }
    if (mutation.op === "sheetPaste") {
      const bag = mutation as OfficeMutation & { _values?: string[][] };
      bag._values ??= copyRange(book, mutation.name, mutation.row, mutation.col, mutation.values.length, mutation.values[0]?.length ?? 0);
      if (reversing) pasteRange(book, mutation.name, mutation.row, mutation.col, bag._values);
      else pasteRange(book, mutation.name, mutation.row, mutation.col, mutation.values);
    }
  }

  private applySlide(mutation: OfficeMutation, reversing: boolean) {
    const presentation = this.deck();
    if (mutation.op === "slideText") {
      const slide = presentation.slides[mutation.index];
      if (!slide) return;
      const shape = slide.shapes.find((item) => item.id === mutation.shapeId);
      const bag = mutation as OfficeMutation & { _prev?: string };
      bag._prev ??= shape?.text ?? "";
      updateShapeText(slide, mutation.shapeId, reversing ? bag._prev : mutation.text);
      return;
    }
    if (mutation.op === "slideAdd") {
      const bag = mutation as OfficeMutation & { _index?: number };
      if (reversing) {
        if (bag._index != null) deleteSlide(presentation, bag._index);
        return;
      }
      const slide = addBlankSlide(presentation);
      bag._index = slide.index;
      return;
    }
    if (mutation.op === "slideDelete") {
      const bag = mutation as OfficeMutation & { _slide?: SlideModel };
      if (!reversing) {
        bag._slide = structuredClone(presentation.slides[mutation.index]);
        deleteSlide(presentation, mutation.index);
        return;
      }
      if (bag._slide) {
        presentation.slides.splice(mutation.index, 0, structuredClone(bag._slide));
        presentation.slides.forEach((slide, index) => { slide.index = index; });
      }
      return;
    }
    if (mutation.op === "slideDuplicate") {
      if (reversing) deleteSlide(presentation, mutation.index + 1);
      else duplicateSlide(presentation, mutation.index);
      return;
    }
    if (mutation.op === "slideBackground") {
      const slide = presentation.slides[mutation.index];
      if (!slide) return;
      const bag = mutation as OfficeMutation & { _prev?: string };
      bag._prev ??= slide.background;
      setSlideBackground(slide, reversing ? bag._prev : mutation.background);
      return;
    }
    if (mutation.op === "slideShape") {
      const slide = presentation.slides[mutation.index];
      const shape = slide?.shapes.find((item) => item.id === mutation.shapeId);
      if (!slide || !shape) return;
      const bag = mutation as OfficeMutation & { _prev?: typeof mutation.patch };
      bag._prev ??= { bold: shape.bold, italic: shape.italic, fontSize: shape.fontSize, align: shape.align, color: shape.color, text: shape.text };
      updateShapeStyle(slide, mutation.shapeId, reversing ? bag._prev : mutation.patch);
      return;
    }
    if (mutation.op === "slideDeleteShape") {
      const slide = presentation.slides[mutation.index];
      if (!slide) return;
      const bag = mutation as OfficeMutation & { _shape?: SlideModel["shapes"][number]; _at?: number };
      if (!reversing) {
        bag._at = slide.shapes.findIndex((item) => item.id === mutation.shapeId);
        bag._shape = structuredClone(slide.shapes[bag._at]);
        deleteShape(slide, mutation.shapeId);
        return;
      }
      if (bag._shape) slide.shapes.splice(bag._at ?? slide.shapes.length, 0, structuredClone(bag._shape));
    }
  }

  private resultOf(mutation: OfficeMutation) {
    if (isWord(this.model) && mutation.op.startsWith("word")) {
      return { totalBlocks: this.model.blocks.length, block: "index" in mutation ? this.model.blocks[mutation.index] : undefined };
    }
    if (isWorkbook(this.model) && mutation.op.startsWith("sheet")) {
      const name = mutation.op === "sheetAdd"
        ? (mutation as OfficeMutation & { _name?: string })._name
        : "name" in mutation && mutation.name ? mutation.name : this.model.sheets[0]?.name;
      const row = "row" in mutation ? mutation.row : 0;
      return {
        name,
        sheets: this.model.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows, cols: sheet.cols })),
        active: name ? readViewport(this.model, name, Math.max(0, row - 20), 60, 0, Math.max(SHEET_INITIAL_COLS, this.model.sheets.find((sheet) => sheet.name === name)?.cols ?? SHEET_INITIAL_COLS)) : null,
      };
    }
    if (isPresentation(this.model)) {
      const index = "index" in mutation ? mutation.index : this.model.slides.length - 1;
      return {
        slides: this.model.slides.map((slide) => ({ index: slide.index, title: slide.title })),
        slide: this.model.slides[Math.min(index, this.model.slides.length - 1)] ?? null,
      };
    }
    return true;
  }

  wordChunk(offset: number, count: number) {
    if (!isWord(this.model)) throw new Error("当前文档不是 Word 文档");
    return this.model.blocks.slice(offset, offset + count);
  }

  sheetViewport(name: string, rowStart: number, rowCount: number, colStart: number, colCount: number) {
    return readViewport(this.book(), name, rowStart, rowCount, colStart, colCount);
  }

  slideAt(index: number) {
    return this.deck().slides[index] ?? this.deck().slides[0] ?? null;
  }

  copyCells(name: string, row: number, col: number, rowCount: number, colCount: number) {
    return copyRange(this.book(), name, row, col, rowCount, colCount);
  }
}

export function workbookViewportAfterEdit(book: WorkbookModel, name: string, row: number) {
  return readViewport(book, name, Math.max(0, row - 20), 60, 0, Math.max(SHEET_INITIAL_COLS, book.sheets.find((sheet) => sheet.name === name)?.cols ?? SHEET_INITIAL_COLS));
}
