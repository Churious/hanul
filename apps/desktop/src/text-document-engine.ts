import type {
  CharacterFormat,
  ContentLossReport,
  DocumentEngine,
  DocumentInfo,
  DocumentSession,
  DocumentStyle,
  ExportResult,
  HeaderFooterFieldKind,
  HeaderFooterInfo,
  HeaderFooterKind,
  HeaderFooterScope,
  PageDefinition,
  ParagraphFormat,
  RenderedPageInfo,
  SearchMatch,
  SearchOptions,
  SelectionRectangle,
  TableCommand,
  TextPosition,
} from "./document-engine";

export interface PlainTextParagraph {
  text: string;
  pageBreakBefore: boolean;
  paragraphFormat: ParagraphFormat;
  characterFormats: Array<{ start: number; end: number; format: CharacterFormat }>;
}

export interface PlainTextSerializer {
  serialize(paragraphs: readonly PlainTextParagraph[], format: "hwp" | "hwpx", pageDefinition: PageDefinition): ExportResult;
}

export interface ImportedPlainTextDocument {
  paragraphs: readonly Partial<PlainTextParagraph>[];
  pageDefinition: PageDefinition;
  sourceFormat: "hwp" | "hwpx";
}

export interface DisplayTextLine {
  paragraphIndex: number;
  paragraphId: number;
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  textLength?: number;
}

export interface DisplayPageList {
  pageIndex: number;
  width: number;
  height: number;
  lines: readonly DisplayTextLine[];
}

export interface TextEngineMetrics {
  modelMutationMs: number;
  incrementalLayoutMs: number;
  invalidatedParagraphs: number;
  invalidatedPages: number;
  renderedPageMs: number;
}

interface FlowState { page: number; line: number }
interface TextLine extends DisplayTextLine { pageIndex: number; lineIndex: number }
interface Para {
  id: number;
  text: string;
  pageBreakBefore: boolean;
  paragraphFormat: ParagraphFormat;
  characterFormats: Array<{ start: number; end: number; format: CharacterFormat }>;
  lines: Array<{ start: number; end: number; text: string; fontSize: number }>;
  placed: TextLine[];
  inputState: FlowState;
  startState: FlowState;
  endState: FlowState;
  priority: number;
  left: Para | null;
  right: Para | null;
  parent: Para | null;
  size: number;
  lineTotal: number;
}

interface HistoryEntry {
  index: number;
  before: PlainTextParagraph[];
  after: PlainTextParagraph[];
  beforeCaret: TextPosition;
  afterCaret: TextPosition;
  typing: boolean;
  pageDefinitionBefore?: PageDefinition;
  pageDefinitionAfter?: PageDefinition;
}

const DEFAULT_PAGE: PageDefinition = {
  width: 210, height: 297, marginLeft: 25, marginRight: 25,
  marginTop: 20, marginBottom: 20, marginHeader: 10, marginFooter: 10,
  marginGutter: 0, landscape: false, binding: 0,
};
const PX_PER_MM = 96 / 25.4;
// RHWP's paragraph inspection API reports margins in CSS pixels, while its
// applyParaFormat API accepts its 200-units-per-point paragraph coordinates.
const RHWP_PARA_UNITS_PER_CSS_PX = 150;
const DEFAULT_FONT_SIZE = 16;
const DEFAULT_FONT_RAW_SIZE = 1200;
const DEFAULT_LINE_HEIGHT = 22;
const MAX_HISTORY = 500;

function cloneFormat<T extends object>(value: T): T { return { ...value }; }
function cloneParagraph(p: Para | PlainTextParagraph): PlainTextParagraph {
  return {
    text: p.text,
    pageBreakBefore: p.pageBreakBefore,
    paragraphFormat: cloneFormat(p.paragraphFormat),
    characterFormats: p.characterFormats.map((r) => ({ ...r, format: cloneFormat(r.format) })),
  };
}
function size(node: Para | null): number { return node?.size ?? 0; }
function lines(node: Para | null): number { return node?.lineTotal ?? 0; }
function update(node: Para | null): Para | null {
  if (!node) return null;
  node.size = 1 + size(node.left) + size(node.right);
  node.lineTotal = node.lines.length + lines(node.left) + lines(node.right);
  if (node.left) node.left.parent = node;
  if (node.right) node.right.parent = node;
  return node;
}
function merge(a: Para | null, b: Para | null): Para | null {
  if (!a) { if (b) b.parent = null; return b; }
  if (!b) { a.parent = null; return a; }
  if (a.priority <= b.priority) {
    a.right = merge(a.right, b);
    const result = update(a)!; result.parent = null; return result;
  }
  b.left = merge(a, b.left);
  const result = update(b)!; result.parent = null; return result;
}
function split(root: Para | null, count: number): [Para | null, Para | null] {
  if (!root) return [null, null];
  if (size(root.left) >= count) {
    const [a, b] = split(root.left, count);
    root.left = b;
    const right = update(root)!;
    if (a) a.parent = null;
    right.parent = null;
    return [a, right];
  }
  const [a, b] = split(root.right, count - size(root.left) - 1);
  root.right = a;
  const left = update(root)!;
  left.parent = null;
  if (b) b.parent = null;
  return [left, b];
}
function at(root: Para | null, index: number): Para {
  if (!root) throw new RangeError("문단이 없습니다.");
  const left = size(root.left);
  if (index < left) return at(root.left, index);
  if (index === left) return root;
  return at(root.right, index - left - 1);
}
function indexOf(node: Para): number {
  let index = size(node.left);
  let current = node;
  while (current.parent) {
    if (current === current.parent.right) index += size(current.parent.left) + 1;
    current = current.parent;
  }
  return index;
}
function iterate(root: Para | null, startIndex = 0): Para[] {
  if (!root) return [];
  const result: Para[] = [];
  const stack: Para[] = [];
  let current: Para | null = root;
  let skipped = 0;
  while (current || stack.length) {
    while (current) { stack.push(current); current = current.left; }
    const node = stack.pop()!;
    if (skipped >= startIndex) result.push(node); else skipped++;
    current = node.right;
  }
  return result;
}
function* iterateFrom(root: Para | null, startIndex: number): Generator<Para> {
  if (!root || startIndex >= size(root)) return;
  let current: Para | null = at(root, Math.max(0, startIndex));
  while (current) {
    yield current;
    if (current.right) {
      current = current.right;
      while (current.left) current = current.left;
    } else {
      let child: Para = current;
      current = child.parent;
      while (current && current.right === child) { child = current; current = current.parent; }
    }
  }
}
function refreshUp(node: Para | null): void { let current = node; while (current) { update(current); current = current.parent; } }

function createNode(id: number, value: Partial<PlainTextParagraph>, priority: number): Para {
  return {
    id, text: value.text ?? "", pageBreakBefore: value.pageBreakBefore ?? false,
    paragraphFormat: cloneFormat(value.paragraphFormat ?? {}),
    characterFormats: (value.characterFormats ?? []).map((r) => ({ ...r, format: cloneFormat(r.format) })),
    lines: [], placed: [], inputState: { page: 0, line: 0 }, startState: { page: 0, line: 0 }, endState: { page: 0, line: 0 },
    priority, left: null, right: null, parent: null, size: 1, lineTotal: 0,
  };
}

/**
 * Hanul's paragraph-oriented text model. Paragraph sequence edits use an implicit
 * treap, so locating and replacing a paragraph is O(log n) and does not copy the
 * document. Text is stored per paragraph; only the edited paragraph string is
 * copied when JavaScript applies a splice.
 */
export class HanulTextDocumentSession implements DocumentSession {
  readonly engineId = "hanul-text";
  readonly sourceFormat: string;
  pageDefinitionValue: PageDefinition;
  private root: Para | null = null;
  private nodesById = new Map<number, Para>();
  private nextId = 1;
  private randomState = 0x6d2b79f5;
  private pageLineIndex = new Map<number, TextLine[]>();
  private pageSvgCache = new Map<number, string>();
  private pageRevisions = new Map<number, number>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private serializer: PlainTextSerializer | null;
  private _pageCount = 1;
  private _metrics: TextEngineMetrics = { modelMutationMs: 0, incrementalLayoutMs: 0, invalidatedParagraphs: 0, invalidatedPages: 0, renderedPageMs: 0 };

  constructor(
    serializer: PlainTextSerializer | null,
    initial: readonly Partial<PlainTextParagraph>[] = [{}],
    pageDefinition: PageDefinition = DEFAULT_PAGE,
    sourceFormat = "hwp",
  ) {
    this.serializer = serializer;
    this.pageDefinitionValue = { ...pageDefinition };
    this.sourceFormat = sourceFormat;
    const values = initial.length ? initial : [{}];
    for (const value of values) { const node = createNode(this.nextId++, value, this.priority()); this.nodesById.set(node.id, node); this.root = merge(this.root, node); }
    this.reflowFrom(0, new Set(iterate(this.root).map((p) => p.id)));
  }

  get pageCount(): number { return this._pageCount; }
  renderRevision(pageIndex: number): number { return this.pageRevisions.get(pageIndex) ?? 0; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get metrics(): Readonly<TextEngineMetrics> { return this._metrics; }
  documentInfo(): DocumentInfo { return { version: "Hanul Text Model 1", sectionCount: 1, pageCount: this.pageCount, fontsUsed: ["Noto Sans CJK KR"] }; }

  pageInfo(pageIndex: number): RenderedPageInfo {
    this.requirePage(pageIndex);
    return { pageIndex, pageNumber: pageIndex + 1, width: this.pageWidthPx(), height: this.pageHeightPx(), sectionIndex: 0 };
  }

  displayList(pageIndex: number): DisplayPageList {
    this.requirePage(pageIndex);
    const lines = (this.pageLineIndex.get(pageIndex) ?? []).map((line) => ({ ...line, paragraphIndex: indexOf(this.nodesById.get(line.paragraphId)!) }));
    return { pageIndex, width: this.pageWidthPx(), height: this.pageHeightPx(), lines: lines.sort((a, b) => a.y - b.y) };
  }

  renderPage(pageIndex: number): string {
    this.requirePage(pageIndex);
    const cached = this.pageSvgCache.get(pageIndex);
    if (cached) return cached;
    const start = clockNow();
    const page = this.displayList(pageIndex);
    const width = page.width; const height = page.height;
    const linesSvg = page.lines.map((line) => `<text x="${line.x.toFixed(2)}" y="${line.y.toFixed(2)}" font-family="${escapeXml(line.fontFamily)}, sans-serif" font-size="${line.fontSize}px" font-weight="${line.bold ? 700 : 400}" font-style="${line.italic ? "italic" : "normal"}" text-decoration="${[line.underline ? "underline" : "", line.strikethrough ? "line-through" : ""].filter(Boolean).join(" ") || "none"}"${line.textLength ? ` textLength="${line.textLength.toFixed(2)}" lengthAdjust="spacing"` : ""} fill="#161616">${escapeXml(line.text)}</text>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}px" height="${height}px" viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="100%" height="100%" fill="#fff" stroke="#b8b8b8"/>${linesSvg}</svg>`;
    this.pageSvgCache.set(pageIndex, svg);
    this._metrics = { ...this._metrics, renderedPageMs: clockNow() - start };
    return svg;
  }

  hitTest(pageIndex: number, x: number, y: number): TextPosition {
    this.requirePage(pageIndex);
    const pageLines = this.displayList(pageIndex).lines;
    if (!pageLines.length) return this.positionAt(0, 0);
    const closest = pageLines.reduce((best, line) => Math.abs(line.y - y) < Math.abs(best.y - y) ? line : best);
    const localX = Math.max(0, x - closest.x);
    let offset = 0; let currentX = 0;
    for (const char of Array.from(closest.text)) {
      const width = measureChar(char, closest.fontSize) * this.visualScale(closest);
      if (localX < currentX + width / 2) break;
      offset += char.length; currentX += width;
    }
    return this.positionAt(closest.paragraphIndex, closest.start + offset);
  }

  moveCaret(position: TextPosition, delta: -1 | 1): TextPosition {
    const para = at(this.root, this.clampPara(position.paragraphIndex));
    let offset = Math.max(0, Math.min(para.text.length, position.charOffset));
    if (delta < 0 && offset > 0) offset -= isLowSurrogate(para.text.charCodeAt(offset - 1)) && offset > 1 ? 2 : 1;
    else if (delta > 0 && offset < para.text.length) offset += isHighSurrogate(para.text.charCodeAt(offset)) && offset + 1 < para.text.length ? 2 : 1;
    else if (delta < 0 && indexOf(para) > 0) return this.positionAt(indexOf(para) - 1, at(this.root, indexOf(para) - 1).text.length);
    else if (delta > 0 && indexOf(para) + 1 < this.paragraphCount()) return this.positionAt(indexOf(para) + 1, 0);
    return this.positionAt(indexOf(para), offset);
  }

  moveCaretVertical(position: TextPosition, delta: -1 | 1): TextPosition {
    const page = position.cursorRect.pageIndex;
    const current = (this.pageLineIndex.get(page) ?? []).slice().sort((a, b) => a.y - b.y);
    const para = at(this.root, this.clampPara(position.paragraphIndex));
    const lineIndex = current.findIndex((line) => line.paragraphId === para.id && position.charOffset >= line.start && position.charOffset <= line.end);
    const localTarget = lineIndex + delta;
    if (lineIndex >= 0 && localTarget >= 0 && localTarget < current.length) {
      const target = current[localTarget]; return this.hitTest(page, position.cursorRect.x, target.y);
    }
    const targetPage = Math.max(0, Math.min(this.pageCount - 1, page + delta));
    const targetLines = (this.pageLineIndex.get(targetPage) ?? []).slice().sort((a, b) => a.y - b.y);
    if (!targetLines.length) return position;
    const target = delta < 0 ? targetLines[targetLines.length - 1] : targetLines[0];
    return this.hitTest(targetPage, position.cursorRect.x, target.y);
  }

  moveCaretToParagraphEdge(position: TextPosition, edge: "start" | "end"): TextPosition {
    const p = at(this.root, this.clampPara(position.paragraphIndex));
    return this.positionAt(indexOf(p), edge === "start" ? 0 : p.text.length);
  }

  insertText(position: TextPosition, text: string): TextPosition { return this.replaceRange(position, position, text); }

  deleteText(position: TextPosition, direction: "backward" | "forward"): TextPosition {
    const p = at(this.root, this.clampPara(position.paragraphIndex));
    const offset = Math.max(0, Math.min(p.text.length, position.charOffset));
    if (direction === "backward" && offset === 0) {
      if (indexOf(p) === 0) return this.positionAt(0, 0);
      const previous = at(this.root, indexOf(p) - 1);
      return this.deleteRange(this.positionAt(indexOf(previous), previous.text.length), this.positionAt(indexOf(p), 0));
    }
    if (direction === "forward" && offset === p.text.length) {
      if (indexOf(p) + 1 >= this.paragraphCount()) return this.positionAt(indexOf(p), offset);
      return this.deleteRange(this.positionAt(indexOf(p), offset), this.positionAt(indexOf(p) + 1, 0));
    }
    const before = direction === "backward" ? this.moveCaret(this.positionAt(indexOf(p), offset), -1) : this.positionAt(indexOf(p), offset);
    const after = direction === "backward" ? this.positionAt(indexOf(p), offset) : this.moveCaret(this.positionAt(indexOf(p), offset), 1);
    return this.deleteRange(before, after);
  }

  splitParagraph(position: TextPosition): TextPosition { return this.replaceRange(position, position, "\n"); }
  insertPageBreak(position: TextPosition): TextPosition {
    const paragraphIndex = this.clampPara(position.paragraphIndex);
    const before = this.snapshotBlock(paragraphIndex, 1);
    const historyStart = this.undoStack.length;
    const next = this.splitParagraph(position);
    const p = at(this.root, this.clampPara(next.paragraphIndex));
    const paraIndex = indexOf(p);
    p.pageBreakBefore = true;
    this.reflowFrom(paraIndex, new Set([p.id]));
    const after = this.snapshotBlock(paragraphIndex, paraIndex - paragraphIndex + 1);
    this.undoStack.splice(historyStart);
    this.recordSnapshot(paragraphIndex, before, after, position, next, false);
    return this.positionAt(paraIndex, next.charOffset);
  }

  undo(): TextPosition | null {
    const entry = this.undoStack.pop(); if (!entry) return null;
    if (entry.pageDefinitionBefore) {
      this.pageDefinitionValue = { ...entry.pageDefinitionBefore };
      this.reflowFrom(0, new Set(iterate(this.root).map((p) => p.id)));
      this.redoStack.push(entry);
      return this.positionAt(entry.beforeCaret.paragraphIndex, entry.beforeCaret.charOffset);
    }
    this.replaceParagraphBlock(entry.index, entry.after.length, entry.before, entry.beforeCaret);
    this.redoStack.push(entry);
    return this.positionAt(entry.beforeCaret.paragraphIndex, entry.beforeCaret.charOffset);
  }
  redo(): TextPosition | null {
    const entry = this.redoStack.pop(); if (!entry) return null;
    if (entry.pageDefinitionAfter) {
      this.pageDefinitionValue = { ...entry.pageDefinitionAfter };
      this.reflowFrom(0, new Set(iterate(this.root).map((p) => p.id)));
      this.undoStack.push(entry);
      return this.positionAt(entry.afterCaret.paragraphIndex, entry.afterCaret.charOffset);
    }
    this.replaceParagraphBlock(entry.index, entry.before.length, entry.after, entry.afterCaret);
    this.undoStack.push(entry);
    return this.positionAt(entry.afterCaret.paragraphIndex, entry.afterCaret.charOffset);
  }

  selectionRectangles(start: TextPosition, end: TextPosition): SelectionRectangle[] {
    const [a, b] = this.ordered(start, end); const result: SelectionRectangle[] = [];
    for (let i = a.paragraphIndex; i <= b.paragraphIndex; i++) {
      const p = at(this.root, i); const from = i === a.paragraphIndex ? a.charOffset : 0; const to = i === b.paragraphIndex ? b.charOffset : p.text.length;
      for (const placed of p.placed) {
        const left = Math.max(from, placed.start); const right = Math.min(to, placed.end);
        if (left >= right && !(from === to && left === right)) continue;
        const scale = this.visualScale(placed);
        const x1 = placed.x + measureText(p.text.slice(placed.start, left), placed.fontSize) * scale;
        const width = Math.max(2, measureText(p.text.slice(left, Math.max(left, right)), placed.fontSize) * scale);
        result.push({ pageIndex: placed.pageIndex, x: x1, y: placed.y - placed.fontSize, width, height: DEFAULT_LINE_HEIGHT });
      }
    }
    return result;
  }

  characterProperties(position: TextPosition): Record<string, unknown> {
    const p = at(this.root, this.clampPara(position.paragraphIndex));
    const run = p.characterFormats.find((r) => position.charOffset >= r.start && position.charOffset < r.end);
    return { fontFamily: "함초롬바탕", fontSize: run?.format.fontSize ?? DEFAULT_FONT_RAW_SIZE, ...run?.format };
  }
  clearTypingFormat(): void { /* The text PoC has no pending-format state. */ }
  applyCharacterFormat(start: TextPosition, end: TextPosition, format: CharacterFormat): TextPosition {
    const [a, b] = this.ordered(start, end); if (a.paragraphIndex === b.paragraphIndex && a.charOffset === b.charOffset) return this.positionAt(a.paragraphIndex, a.charOffset);
    const first = a.paragraphIndex; const last = b.paragraphIndex; const before = this.snapshotBlock(first, last - first + 1);
    for (let i = first; i <= last; i++) {
      const p = at(this.root, i); const from = i === first ? a.charOffset : 0; const to = i === last ? b.charOffset : p.text.length;
      if (to <= from) continue;
      p.characterFormats = applyRunFormat(p.characterFormats, from, to, format);
    }
    const changedIds = new Set<number>();
    for (let i = first; i <= last; i++) changedIds.add(at(this.root, i).id);
    this.reflowFrom(first, changedIds);
    const after = this.snapshotBlock(first, last - first + 1); this.recordSnapshot(first, before, after, a, a, false);
    return this.positionAt(a.paragraphIndex, a.charOffset);
  }
  paragraphProperties(position: TextPosition): Record<string, unknown> { return { ...at(this.root, this.clampPara(position.paragraphIndex)).paragraphFormat }; }
  applyParagraphFormat(position: TextPosition, format: ParagraphFormat): TextPosition {
    const p = at(this.root, this.clampPara(position.paragraphIndex)); const before = cloneParagraph(p);
    const normalized: ParagraphFormat = { ...format };
    for (const key of ["marginLeft", "marginRight", "indent"] as const) {
      if (typeof normalized[key] === "number") normalized[key] = normalized[key]! / RHWP_PARA_UNITS_PER_CSS_PX;
    }
    p.paragraphFormat = { ...p.paragraphFormat, ...normalized }; this.reflowFrom(indexOf(p), new Set([p.id]));
    this.recordSnapshot(indexOf(p), [before], [cloneParagraph(p)], position, position, false);
    return this.positionAt(indexOf(p), position.charOffset);
  }
  applyParagraphAlignment(position: TextPosition, alignment: "left" | "center" | "right" | "justify"): TextPosition { return this.applyParagraphFormat(position, { alignment }); }
  styleList(): DocumentStyle[] { return []; }
  applyStyle(_position: TextPosition, _styleId: number): TextPosition { throw unsupported("스타일 적용"); }
  pageDefinition(_sectionIndex: number): PageDefinition { return { ...this.pageDefinitionValue }; }
  setPageDefinition(position: TextPosition, updates: Partial<PageDefinition>): TextPosition {
    const before = { ...this.pageDefinitionValue };
    const next = { ...before, ...updates };
    const lengths = [next.width, next.height, next.marginLeft, next.marginRight, next.marginTop, next.marginBottom, next.marginHeader, next.marginFooter, next.marginGutter];
    if (lengths.some((value) => !Number.isFinite(value) || value < 0) || next.width < 10 || next.height < 10
      || next.marginLeft + next.marginRight >= next.width || next.marginTop + next.marginBottom >= next.height) {
      throw new Error("용지 크기와 여백 값을 확인하세요.");
    }
    if (JSON.stringify(before) === JSON.stringify(next)) return position;
    this.pageDefinitionValue = next;
    this.reflowFrom(0, new Set(iterate(this.root).map((p) => p.id)));
    const caret = this.positionAt(position.paragraphIndex, position.charOffset);
    this.undoStack.push({
      index: 0, before: [], after: [], beforeCaret: position, afterCaret: caret, typing: false,
      pageDefinitionBefore: before, pageDefinitionAfter: { ...next },
    });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    return caret;
  }

  insertHeaderFooterText(_position: TextPosition, _kind: HeaderFooterKind, _text: string): TextPosition { throw unsupported("머리말·꼬리말"); }
  headerFooterInfo(_position: TextPosition, _kind: HeaderFooterKind, _scope: HeaderFooterScope): HeaderFooterInfo { return { sectionIndex: 0, applyTo: 0, exists: false, text: "" }; }
  setHeaderFooterText(_position: TextPosition, _kind: HeaderFooterKind, _scope: HeaderFooterScope, _text: string): TextPosition { throw unsupported("머리말·꼬리말"); }
  deleteHeaderFooter(_position: TextPosition, _kind: HeaderFooterKind, _scope: HeaderFooterScope): TextPosition { throw unsupported("머리말·꼬리말"); }
  insertHeaderFooterField(_position: TextPosition, _kind: HeaderFooterKind, _scope: HeaderFooterScope, _field: HeaderFooterFieldKind): TextPosition { throw unsupported("머리말·꼬리말 필드"); }
  insertPicture(_position: TextPosition, _imageData: Uint8Array, _extension: string, _naturalWidthPx: number, _naturalHeightPx: number, _widthMm: number, _heightMm: number): TextPosition { throw unsupported("그림 삽입"); }
  insertShape(_position: TextPosition, _kind: "rectangle" | "textBox", _widthMm: number, _heightMm: number): TextPosition { throw unsupported("도형 삽입"); }
  listObjects(_sectionIndex: number) { return []; }
  hitTestObject(_pageIndex: number, _x: number, _y: number) { return null; }
  updateObject(_object: import("./document-engine").DocumentObject, _updates: import("./document-engine").DocumentObjectUpdates): TextPosition { throw unsupported("개체 편집"); }
  deleteObject(_object: import("./document-engine").DocumentObject): TextPosition { throw unsupported("개체 삭제"); }
  setHyperlink(_start: TextPosition, _end: TextPosition, _uri: string): TextPosition { throw unsupported("하이퍼링크"); }
  insertAutoNumber(_position: TextPosition, _kind: "page" | "current" | "total"): TextPosition { throw unsupported("자동 번호"); }
  insertFootnote(_position: TextPosition, _endnote?: boolean): TextPosition { throw unsupported("각주·미주"); }

  deleteRange(start: TextPosition, end: TextPosition): TextPosition { return this.replaceRange(start, end, ""); }
  replaceRange(start: TextPosition, end: TextPosition, text: string): TextPosition {
    const [a, b] = this.ordered(start, end);
    const before = this.snapshotBlock(a.paragraphIndex, b.paragraphIndex - a.paragraphIndex + 1);
    const originalStart = at(this.root, a.paragraphIndex); const originalEnd = at(this.root, b.paragraphIndex);
    const prefix = originalStart.text.slice(0, a.charOffset); const suffix = originalEnd.text.slice(b.charOffset);
    const insertParts = text.split("\n");
    const replacement: PlainTextParagraph[] = [];
    if (insertParts.length === 1) {
      replacement.push({ ...cloneParagraph(originalStart), text: prefix + insertParts[0] + suffix, characterFormats: retainRuns(originalStart.characterFormats, 0, a.charOffset).concat(retainRuns(originalEnd.characterFormats, b.charOffset, originalEnd.text.length, prefix.length + insertParts[0].length)) });
    } else {
      insertParts.forEach((part, partIndex) => {
        const textPart = partIndex === 0 ? prefix + part : partIndex === insertParts.length - 1 ? part + suffix : part;
        const base = partIndex === 0 ? originalStart : partIndex === insertParts.length - 1 ? originalEnd : originalStart;
        const charRuns = partIndex === 0 ? retainRuns(originalStart.characterFormats, 0, a.charOffset) : [];
        if (partIndex === insertParts.length - 1) charRuns.push(...retainRuns(originalEnd.characterFormats, b.charOffset, originalEnd.text.length, part.length));
        replacement.push({ text: textPart, pageBreakBefore: partIndex === 0 ? originalStart.pageBreakBefore : false, paragraphFormat: cloneFormat(base.paragraphFormat), characterFormats: charRuns });
      });
    }
    const lastPara = a.paragraphIndex + replacement.length - 1;
    const afterOffset = replacement[replacement.length - 1].text.length - suffix.length;
    const afterCaret = this.replaceParagraphBlock(a.paragraphIndex, before.length, replacement, {
      sectionIndex: 0, paragraphIndex: lastPara, charOffset: afterOffset,
      cursorRect: { ...start.cursorRect },
    });
    const typing = a.paragraphIndex === b.paragraphIndex && a.charOffset === b.charOffset && text.length > 0 && !text.includes("\n");
    this.recordSnapshot(a.paragraphIndex, before, replacement, start, afterCaret, typing);
    return afterCaret;
  }
  selectedText(start: TextPosition, end: TextPosition): string {
    const [a, b] = this.ordered(start, end); const parts: string[] = [];
    for (let i = a.paragraphIndex; i <= b.paragraphIndex; i++) { const p = at(this.root, i); parts.push(p.text.slice(i === a.paragraphIndex ? a.charOffset : 0, i === b.paragraphIndex ? b.charOffset : p.text.length)); }
    return parts.join("\n");
  }
  searchText(query: string, options?: SearchOptions | boolean): SearchMatch[] {
    if (!query) return [];
    const caseSensitive = typeof options === "boolean" ? options : options?.caseSensitive ?? false;
    const term = caseSensitive ? query : query.toLocaleLowerCase(); const matches: SearchMatch[] = [];
    for (const p of iterate(this.root)) {
      const haystack = caseSensitive ? p.text : p.text.toLocaleLowerCase(); let offset = 0;
      while ((offset = haystack.indexOf(term, offset)) >= 0) { matches.push({ start: this.positionAt(indexOf(p), offset), end: this.positionAt(indexOf(p), offset + query.length), matchedText: p.text.slice(offset, offset + query.length) }); offset += Math.max(query.length, 1); }
    }
    return matches;
  }
  replaceAllText(query: string, replacement: string, options?: SearchOptions | boolean): { count: number; position: TextPosition | null } {
    const hits = this.searchText(query, options); if (!hits.length) return { count: 0, position: null };
    const before = this.snapshotBlock(0, this.paragraphCount()); const historyStart = this.undoStack.length; let first: TextPosition | null = null;
    for (const hit of [...hits].reverse()) { const pos = this.replaceRange(hit.start, hit.end, replacement); first = pos; }
    // Coalesce all replacements into one undo item rather than exposing a partial sequence.
    const after = this.snapshotBlock(0, this.paragraphCount()); this.undoStack.splice(historyStart); this.redoStack = [];
    this.recordSnapshot(0, before, after, hits[0].start, first ?? hits[0].start, false);
    return { count: hits.length, position: first };
  }
  createTable(_position: TextPosition, _rows: number, _columns: number): TextPosition { throw unsupported("표 삽입"); }
  moveTableCell(_position: TextPosition, _delta: -1 | 1): TextPosition { throw unsupported("표 셀 이동"); }
  editTable(_position: TextPosition, _command: TableCommand): TextPosition { throw unsupported("표 편집"); }

  exportWithReport(format: "hwp" | "hwpx" = "hwp"): ExportResult {
    if (!this.serializer) throw new Error("문서 저장 어댑터가 준비되지 않았습니다.");
    return this.serializer.serialize(this.paragraphs(), format, this.pageDefinitionValue);
  }
  dispose(): void { this.serializer = null; this.pageSvgCache.clear(); this.pageLineIndex.clear(); this.pageRevisions.clear(); this.nodesById.clear(); this.root = null; }

  paragraphs(): PlainTextParagraph[] { return iterate(this.root).map((p) => cloneParagraph(p)); }

  private replaceParagraphBlock(index: number, deleteCount: number, values: readonly Partial<PlainTextParagraph>[], caret: TextPosition): TextPosition {
    const started = clockNow(); const first = this.clampPara(index); const removed = Array.from({ length: deleteCount }, (_, offset) => at(this.root, first + offset));
    const dirtyPages = new Set<number>();
    for (const p of removed) { this.removeParagraphDisplay(p, dirtyPages); this.nodesById.delete(p.id); }
    const [left, tail] = split(this.root, first); const [, right] = split(tail, deleteCount);
    let middle: Para | null = null;
    const created: Para[] = [];
    for (const value of values.length ? values : [{}]) { const node = createNode(this.nextId++, value, this.priority()); this.nodesById.set(node.id, node); created.push(node); middle = merge(middle, node); }
    this.root = merge(merge(left, middle), right);
    const modelMutationMs = clockNow() - started;
    const startState = first === 0 ? { page: 0, line: 0 } : { ...at(this.root, first - 1).endState };
    this.reflowFrom(first, new Set(created.map((p) => p.id)), startState, dirtyPages);
    this._metrics = { ...this._metrics, modelMutationMs };
    return this.positionAt(Math.min(first + created.length - 1, this.paragraphCount() - 1), caret.charOffset);
  }

  private reflowFrom(index: number, changedIds: Set<number>, startAt?: FlowState, initiallyDirty?: Set<number>): void {
    const start = clockNow(); const first = this.clampPara(index);
    let state = startAt ?? (first === 0 ? { page: 0, line: 0 } : { ...at(this.root, first - 1).endState });
    const dirtyPages = initiallyDirty ?? new Set<number>(); let invalidated = 0; let processedToEnd = true; let lastNode: Para | null = null;
    for (const p of iterateFrom(this.root, first)) {
      // If an unchanged paragraph receives the same incoming pagination state,
      // all following layout positions remain valid. Avoid measuring its text.
      if (!changedIds.has(p.id) && equalState(state, p.inputState)) { processedToEnd = false; lastNode = at(this.root, this.paragraphCount() - 1); break; }
      this.removeParagraphDisplay(p, dirtyPages);
      p.inputState = { ...state };
      if (p.pageBreakBefore && state.line !== 0) state = { page: state.page + 1, line: 0 };
      p.startState = { ...state };
      this.layout(p);
      const placements: TextLine[] = [];
      const paraIndex = indexOf(p);
      for (let lineIndex = 0; lineIndex < p.lines.length; lineIndex += 1) {
        const line = p.lines[lineIndex];
        if (state.line >= this.linesPerPage()) state = { page: state.page + 1, line: 0 };
        const x = this.contentX(p, line.text, line.fontSize); const y = this.contentY() + state.line * DEFAULT_LINE_HEIGHT + line.fontSize;
        const format = p.characterFormats.find((run) => line.start >= run.start && line.start < run.end)?.format ?? {};
        const justified = p.paragraphFormat.alignment === "justify" && lineIndex < p.lines.length - 1;
        const placed = { paragraphIndex: paraIndex, paragraphId: p.id, start: line.start, end: line.end, text: line.text, x, y, fontSize: line.fontSize, fontFamily: format.fontFamily ?? "함초롬바탕", bold: format.bold ?? false, italic: format.italic ?? false, underline: format.underline ?? false, strikethrough: format.strikethrough ?? false, ...(justified ? { textLength: this.availableTextWidth(p) } : {}), pageIndex: state.page, lineIndex: state.line };
        placements.push(placed); dirtyPages.add(state.page);
        const bucket = this.pageLineIndex.get(state.page) ?? []; bucket.push(placed); this.pageLineIndex.set(state.page, bucket);
        state = { page: state.page, line: state.line + 1 };
      }
      p.placed = placements; p.endState = { ...state }; refreshUp(p); invalidated++; lastNode = p; changedIds.delete(p.id);
    }
    if (processedToEnd) lastNode = at(this.root, this.paragraphCount() - 1);
    if (lastNode) this._pageCount = Math.max(1, lastNode.endState.page + 1);
    for (const page of dirtyPages) {
      this.pageSvgCache.delete(page);
      this.pageRevisions.set(page, (this.pageRevisions.get(page) ?? 0) + 1);
    }
    // Remove empty page buckets left by a deleted trailing page.
    for (const page of [...this.pageLineIndex.keys()]) if (page >= this._pageCount) this.pageLineIndex.delete(page);
    this._metrics = { ...this._metrics, incrementalLayoutMs: clockNow() - start, invalidatedParagraphs: invalidated, invalidatedPages: dirtyPages.size };
    update(this.root);
  }

  private removeParagraphDisplay(p: Para, dirtyPages: Set<number>): void {
    for (const pageIndex of new Set(p.placed.map((line) => line.pageIndex))) {
      dirtyPages.add(pageIndex);
      const bucket = this.pageLineIndex.get(pageIndex)?.filter((line) => line.paragraphId !== p.id) ?? [];
      if (bucket.length) this.pageLineIndex.set(pageIndex, bucket); else this.pageLineIndex.delete(pageIndex);
    }
  }

  private layout(p: Para): void {
    const maxWidth = this.contentWidthPx() - (p.paragraphFormat.marginLeft ?? 0) - (p.paragraphFormat.marginRight ?? 0) - (p.paragraphFormat.indent ?? 0);
    const sizeAt = (offset: number) => fontSizePx(p.characterFormats.find((r) => offset >= r.start && offset < r.end)?.format.fontSize ?? DEFAULT_FONT_RAW_SIZE);
    const chars = Array.from(p.text); const starts: number[] = []; let utf16 = 0;
    for (const char of chars) { starts.push(utf16); utf16 += char.length; }
    const result: Array<{ start: number; end: number; text: string; fontSize: number }> = [];
    let lineStart = 0; let lineWidth = 0; let lineFontSize = sizeAt(0);
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]; const startOffset = starts[i]; const fontSize = sizeAt(startOffset); const charWidth = measureChar(char, fontSize);
      if (i > lineStart && lineWidth + charWidth > maxWidth) {
        const endOffset = starts[i]; result.push({ start: starts[lineStart], end: endOffset, text: p.text.slice(starts[lineStart], endOffset), fontSize: lineFontSize });
        lineStart = i; lineWidth = 0; lineFontSize = fontSize;
      }
      lineWidth += charWidth;
    }
    if (!chars.length || lineStart < chars.length) {
      const startOffset = chars.length ? starts[lineStart] : 0;
      result.push({ start: startOffset, end: p.text.length, text: p.text.slice(startOffset), fontSize: lineFontSize });
    }
    p.lines = result;
  }

  private recordSnapshot(index: number, before: PlainTextParagraph[], after: PlainTextParagraph[], beforeCaret: TextPosition, afterCaret: TextPosition, typing: boolean): void {
    const prior = this.undoStack[this.undoStack.length - 1];
    if (typing && prior?.typing && prior.index === index && prior.afterCaret.paragraphIndex === beforeCaret.paragraphIndex && prior.afterCaret.charOffset === beforeCaret.charOffset) {
      prior.after = after; prior.afterCaret = afterCaret;
    } else {
      this.undoStack.push({ index, before, after, beforeCaret, afterCaret, typing });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
  }
  private snapshotBlock(index: number, count: number): PlainTextParagraph[] { return iterate(this.root, index).slice(0, count).map((p) => cloneParagraph(p)); }
  private paragraphsCountSafe(): number { return Math.max(1, size(this.root)); }
  private paragraphCount(): number { return this.paragraphsCountSafe(); }
  private clampPara(index: number): number { return Math.max(0, Math.min(this.paragraphCount() - 1, Math.trunc(index))); }
  private positionAt(paragraphIndex: number, charOffset: number): TextPosition {
    const i = this.clampPara(paragraphIndex); const p = at(this.root, i); const offset = Math.max(0, Math.min(p.text.length, charOffset));
    const line = p.placed.find((item) => offset >= item.start && offset <= item.end) ?? p.placed[p.placed.length - 1];
    const x = line ? line.x + measureText(p.text.slice(line.start, offset), line.fontSize) * this.visualScale(line) : this.contentX(p, "", DEFAULT_FONT_SIZE);
    const y = line?.y ?? this.contentY() + DEFAULT_FONT_SIZE;
    return { sectionIndex: 0, paragraphIndex: i, charOffset: offset, cursorRect: { pageIndex: line?.pageIndex ?? p.startState.page, x, y: y - DEFAULT_FONT_SIZE, height: DEFAULT_LINE_HEIGHT } };
  }
  private ordered(a: TextPosition, b: TextPosition): [TextPosition, TextPosition] {
    const ai = this.clampPara(a.paragraphIndex); const bi = this.clampPara(b.paragraphIndex);
    return ai < bi || (ai === bi && a.charOffset <= b.charOffset) ? [this.positionAt(ai, a.charOffset), this.positionAt(bi, b.charOffset)] : [this.positionAt(bi, b.charOffset), this.positionAt(ai, a.charOffset)];
  }
  private contentWidthPx(): number { return (this.pageDefinitionValue.width - this.pageDefinitionValue.marginLeft - this.pageDefinitionValue.marginRight) * PX_PER_MM; }
  private availableTextWidth(p: Para): number { return this.contentWidthPx() - (p.paragraphFormat.marginLeft ?? 0) - (p.paragraphFormat.marginRight ?? 0) - (p.paragraphFormat.indent ?? 0); }
  private visualScale(line: DisplayTextLine): number {
    return line.textLength ? line.textLength / Math.max(1, measureText(line.text, line.fontSize)) : 1;
  }
  private contentX(p: Para, text: string, fontSize: number): number {
    const left = this.pageDefinitionValue.marginLeft * PX_PER_MM + (p.paragraphFormat.marginLeft ?? 0) + (p.paragraphFormat.indent ?? 0);
    const alignment = p.paragraphFormat.alignment ?? "left";
    if (alignment === "center") return left + Math.max(0, (this.contentWidthPx() - measureText(text, fontSize)) / 2);
    if (alignment === "right") return left + Math.max(0, this.contentWidthPx() - measureText(text, fontSize));
    return left;
  }
  private contentY(): number { return this.pageDefinitionValue.marginTop * PX_PER_MM; }
  private pageWidthPx(): number { return this.pageDefinitionValue.width * PX_PER_MM; }
  private pageHeightPx(): number { return this.pageDefinitionValue.height * PX_PER_MM; }
  private linesPerPage(): number { return Math.max(1, Math.floor(((this.pageDefinitionValue.height - this.pageDefinitionValue.marginTop - this.pageDefinitionValue.marginBottom) * PX_PER_MM) / DEFAULT_LINE_HEIGHT)); }
  private requirePage(index: number): void { if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) throw new RangeError(`쪽 번호 범위를 벗어났습니다: ${index}`); }
  private priority(): number { this.randomState ^= this.randomState << 13; this.randomState ^= this.randomState >>> 17; this.randomState ^= this.randomState << 5; return this.randomState >>> 0; }
}

export class HanulTextDocumentEngine implements DocumentEngine {
  readonly id = "hanul-text";
  private readonly createSerializer: () => Promise<PlainTextSerializer>;
  constructor(createSerializer: () => Promise<PlainTextSerializer>) { this.createSerializer = createSerializer; }
  async open(_bytes: Uint8Array): Promise<DocumentSession> { throw new Error("HWP/HWPX 가져오기는 파일 형식 어댑터를 통해 수행해야 합니다."); }
  async createBlank(): Promise<DocumentSession> { return new HanulTextDocumentSession(await this.createSerializer()); }
}

export function createInMemoryTextSession(
  initial: readonly Partial<PlainTextParagraph>[] = [{}],
  pageDefinition: PageDefinition = DEFAULT_PAGE,
): HanulTextDocumentSession { return new HanulTextDocumentSession(null, initial, pageDefinition); }

function equalState(a: FlowState, b: FlowState | undefined): boolean { return !!b && a.page === b.page && a.line === b.line; }
function applyRunFormat(runs: PlainTextParagraph["characterFormats"], start: number, end: number, patch: CharacterFormat) {
  const points = [...new Set([start, end, ...runs.flatMap((run) => [run.start, run.end])])].sort((a, b) => a - b);
  const result: PlainTextParagraph["characterFormats"] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const left = points[i]; const right = points[i + 1]; if (right <= left) continue;
    const existing = runs.find((run) => left >= run.start && right <= run.end);
    const selected = left >= start && right <= end;
    if (!existing && !selected) continue;
    const format = { ...(existing?.format ?? {}), ...(selected ? patch : {}) };
    const previous = result[result.length - 1];
    if (previous && previous.end === left && JSON.stringify(previous.format) === JSON.stringify(format)) previous.end = right;
    else result.push({ start: left, end: right, format });
  }
  return result;
}
function retainRuns(runs: PlainTextParagraph["characterFormats"], from: number, to: number, shift = 0) {
  return runs.flatMap((r) => { const start = Math.max(from, r.start); const end = Math.min(to, r.end); return end > start ? [{ start: start - from + shift, end: end - from + shift, format: cloneFormat(r.format) }] : []; });
}
function measureChar(char: string, fontSize: number): number {
  if (/\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)) return fontSize;
  if (/\s/u.test(char)) return fontSize * 0.34;
  if (/^[ilI.,'!:;|]$/u.test(char)) return fontSize * 0.32;
  if (/^[MW@#%&]$/u.test(char)) return fontSize * 0.86;
  return fontSize * 0.56;
}
function measureText(text: string, fontSize: number): number { return Array.from(text).reduce((sum, char) => sum + measureChar(char, fontSize), 0); }
function fontSizePx(rawSize: number): number { return rawSize > 100 ? rawSize * 96 / 7200 : rawSize; }
function escapeXml(text: string): string { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function unsupported(feature: string): Error { return new Error(`${feature}은 새 문서 엔진에서 아직 지원되지 않습니다. 기존 HWP/HWPX 문서를 열거나 RHWP 호환성 엔진을 사용하세요.`); }
function clockNow(): number { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

export const emptyContentLossReport = (format: "hwp" | "hwpx"): ContentLossReport => ({ schemaVersion: 1, outputFormat: format, count: 0, losses: [] });
