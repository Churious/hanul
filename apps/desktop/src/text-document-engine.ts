import type {
  CharacterFormat,
  ContentLossReport,
  DocumentEngine,
  DocumentInfo,
  DocumentObject,
  DocumentObjectKind,
  DocumentObjectTextWrap,
  DocumentObjectUpdates,
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
  TableLayoutInfo,
  TableUpdates,
  TextPosition,
} from "./document-engine";

export interface PlainTextParagraph {
  text: string;
  pageBreakBefore: boolean;
  paragraphFormat: ParagraphFormat;
  characterFormats: Array<{ start: number; end: number; format: CharacterFormat }>;
  table?: PlainTextTable;
  objects?: PlainTextObject[];
}

export interface PlainTextObject extends DocumentObject {
  /** RHWP properties retained for the compatibility serializer. */
  properties: Record<string, unknown>;
  /** Text offset where the floating object's anchor control is stored. */
  anchorCharOffset: number;
  shapeType?: "rectangle" | "ellipse";
  imageData?: Uint8Array;
  imageExtension?: string;
  naturalWidthPx?: number;
  naturalHeightPx?: number;
  preserveAspectRatio?: boolean;
  /** Text box content uses the same paragraph/character model as body text. */
  textParagraphs?: Array<Omit<PlainTextParagraph, "table" | "objects">>;
  paint?: { fillColor: string; strokeColor: string; strokeWidth: number; opacity: number };
  textMarginsMm?: { left: number; right: number; top: number; bottom: number };
}

export interface PlainTextTableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  widthMm: number;
  heightMm: number;
  properties: Record<string, unknown>;
  paragraphs: Array<Omit<PlainTextParagraph, "table">>;
}

export interface PlainTextTable {
  rowCount: number;
  colCount: number;
  columnWidthsMm: number[];
  properties: Record<string, unknown>;
  cells: PlainTextTableCell[];
}

export interface PlainTextSerializer {
  serialize(paragraphs: readonly PlainTextParagraph[], format: "hwp" | "hwpx", pageDefinition: PageDefinition): ExportResult;
}

/**
 * HWP textbox export is intentionally limited to the one structure verified in
 * Hanword 2024: one simple rectangle textbox with one plain text paragraph.
 * Mixed objects, tables, and multi-paragraph textboxes remain on the guarded
 * compatibility path until they have their own product-save validation.
 */
export function plainTextHwpTextboxSaveEligibility(
  paragraphs: readonly PlainTextParagraph[],
): { supported: boolean; reason?: string } {
  const objects = paragraphs.flatMap((paragraph) => paragraph.objects ?? []);
  const textBoxes = objects.filter((object) => object.kind === "textBox");
  if (textBoxes.length === 0) return { supported: true };
  if (objects.length !== 1 || textBoxes.length !== 1) {
    return { supported: false, reason: "HWP 글상자 저장은 검증된 단일 글상자 문서에서만 지원합니다." };
  }
  if (paragraphs.some((paragraph) => paragraph.table)) {
    return { supported: false, reason: "표와 글상자가 함께 있는 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다." };
  }
  const [textBox] = textBoxes;
  if (textBox!.textParagraphs?.length !== 1) {
    return { supported: false, reason: "여러 문단 또는 비어 있는 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다." };
  }
  if (textBox!.shapeType !== undefined && textBox!.shapeType !== "rectangle") {
    return { supported: false, reason: "사각형이 아닌 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다." };
  }
  return { supported: true };
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
  cellIndex?: number;
  cellParaIndex?: number;
  objectControlIndex?: number;
}

export interface DisplayPageList {
  pageIndex: number;
  width: number;
  height: number;
  lines: readonly DisplayTextLine[];
  tables: readonly DisplayTableFragment[];
  objects: readonly DisplayDocumentObject[];
}

export interface DisplayDocumentObject {
  id: string;
  paragraphId: number;
  controlIndex: number;
  kind: DocumentObjectKind;
  pageIndex: number;
  zOrder: number;
  x: number;
  y: number;
  width: number;
  height: number;
  href?: string;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  opacity?: number;
  textWrap: DocumentObjectTextWrap;
}

export interface DisplayTableCell {
  cellIndex: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  x: number;
  y: number;
  width: number;
  height: number;
  properties: Record<string, unknown>;
}

export interface DisplayTableFragment {
  paragraphId: number;
  pageIndex: number;
  cells: readonly DisplayTableCell[];
}

export interface TextEngineMetrics {
  modelMutationMs: number;
  incrementalLayoutMs: number;
  invalidatedParagraphs: number;
  invalidatedPages: number;
  renderedPageMs: number;
}

interface FlowState { page: number; line: number }
interface TextLine extends DisplayTextLine { pageIndex: number; lineIndex: number; cellIndex?: number; cellParaIndex?: number; objectControlIndex?: number }
interface TableCellLayoutLine { start: number; end: number; text: string; fontSize: number; cellParaIndex: number; lineIndex: number; lineCount: number }
interface TableCellLayout { cellIndex: number; lines: TableCellLayoutLine[]; paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number }
type EditableCell = Pick<PlainTextTableCell, "paragraphs" | "properties">;
interface TableRowLayout { row: number; heightLines: number; cells: TableCellLayout[] }
interface Para {
  id: number;
  text: string;
  pageBreakBefore: boolean;
  paragraphFormat: ParagraphFormat;
  characterFormats: Array<{ start: number; end: number; format: CharacterFormat }>;
  table?: PlainTextTable;
  objects: PlainTextObject[];
  tableRows: TableRowLayout[];
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
  flowUnits: number;
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
function cloneTable(table: PlainTextTable | undefined): PlainTextTable | undefined {
  if (!table) return undefined;
  return {
    rowCount: table.rowCount,
    colCount: table.colCount,
    columnWidthsMm: [...table.columnWidthsMm],
    properties: structuredClone(table.properties),
    cells: table.cells.map((cell) => ({
      ...cell,
      properties: structuredClone(cell.properties),
      paragraphs: cell.paragraphs.map((paragraph) => ({
        text: paragraph.text,
        pageBreakBefore: paragraph.pageBreakBefore,
        paragraphFormat: { ...paragraph.paragraphFormat },
        characterFormats: paragraph.characterFormats.map((run) => ({ ...run, format: { ...run.format } })),
      })),
    })),
  };
}
function cloneTextParagraph(paragraph: Omit<PlainTextParagraph, "table" | "objects">): Omit<PlainTextParagraph, "table" | "objects"> {
  return {
    text: paragraph.text,
    pageBreakBefore: paragraph.pageBreakBefore,
    paragraphFormat: cloneFormat(paragraph.paragraphFormat),
    characterFormats: paragraph.characterFormats.map((run) => ({ ...run, format: cloneFormat(run.format) })),
  };
}
function cloneObject(object: PlainTextObject): PlainTextObject {
  return {
    ...object,
    bounds: { ...object.bounds },
    properties: structuredClone(object.properties),
    ...(object.paint ? { paint: { ...object.paint } } : {}),
    ...(object.textMarginsMm ? { textMarginsMm: { ...object.textMarginsMm } } : {}),
    ...(object.textParagraphs ? { textParagraphs: object.textParagraphs.map(cloneTextParagraph) } : {}),
    // Binary assets are immutable in the editor model; snapshots share their
    // backing storage and avoid copying large photos for a geometry edit.
    ...(object.imageData ? { imageData: object.imageData } : {}),
  };
}
function cloneParagraph(p: Para | PlainTextParagraph): PlainTextParagraph {
  return {
    text: p.text,
    pageBreakBefore: p.pageBreakBefore,
    paragraphFormat: cloneFormat(p.paragraphFormat),
    characterFormats: p.characterFormats.map((r) => ({ ...r, format: cloneFormat(r.format) })),
    ...(p.table ? { table: cloneTable(p.table) } : {}),
    ...("objects" in p && p.objects?.length ? { objects: p.objects.map(cloneObject) } : {}),
  };
}
function size(node: Para | null): number { return node?.size ?? 0; }
function lines(node: Para | null): number { return node?.lineTotal ?? 0; }
function update(node: Para | null): Para | null {
  if (!node) return null;
  node.size = 1 + size(node.left) + size(node.right);
  node.lineTotal = node.flowUnits + lines(node.left) + lines(node.right);
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
    ...(value.table ? { table: cloneTable(value.table) } : {}),
    objects: (value.objects ?? []).map(cloneObject),
    tableRows: [],
    lines: [], placed: [], inputState: { page: 0, line: 0 }, startState: { page: 0, line: 0 }, endState: { page: 0, line: 0 },
    priority, left: null, right: null, parent: null, size: 1, lineTotal: 0, flowUnits: 0,
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
  private nextObjectControlIndex = 1000;
  private randomState = 0x6d2b79f5;
  private pageLineIndex = new Map<number, TextLine[]>();
  private pageTableIndex = new Map<number, DisplayTableFragment[]>();
  private pageObjectIndex = new Map<number, DisplayDocumentObject[]>();
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
    for (const value of values) {
      const node = createNode(this.nextId++, value, this.priority());
      for (const object of node.objects) this.nextObjectControlIndex = Math.max(this.nextObjectControlIndex, object.controlIndex + 1);
      this.nodesById.set(node.id, node); this.root = merge(this.root, node);
    }
    this.reflowFrom(0, new Set(iterate(this.root).map((p) => p.id)));
  }

  get pageCount(): number { return this._pageCount; }
  renderRevision(pageIndex: number): number { return this.pageRevisions.get(pageIndex) ?? 0; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  hwpTextboxSaveEligibility(): { supported: boolean; reason?: string } {
    return plainTextHwpTextboxSaveEligibility(this.paragraphs());
  }
  get metrics(): Readonly<TextEngineMetrics> { return this._metrics; }
  performanceMetrics(): Readonly<TextEngineMetrics> { return { ...this._metrics }; }
  documentInfo(): DocumentInfo { return { version: "Hanul Text Model 1", sectionCount: 1, pageCount: this.pageCount, fontsUsed: ["Noto Sans CJK KR"] }; }

  pageInfo(pageIndex: number): RenderedPageInfo {
    this.requirePage(pageIndex);
    return { pageIndex, pageNumber: pageIndex + 1, width: this.pageWidthPx(), height: this.pageHeightPx(), sectionIndex: 0 };
  }

  displayList(pageIndex: number): DisplayPageList {
    this.requirePage(pageIndex);
    const lines = (this.pageLineIndex.get(pageIndex) ?? []).map((line) => ({ ...line, paragraphIndex: indexOf(this.nodesById.get(line.paragraphId)!) }));
    return {
      pageIndex,
      width: this.pageWidthPx(),
      height: this.pageHeightPx(),
      lines: lines.sort((a, b) => a.y - b.y),
      tables: this.pageTableIndex.get(pageIndex) ?? [],
      objects: this.pageObjectIndex.get(pageIndex) ?? [],
    };
  }

  renderPage(pageIndex: number): string {
    this.requirePage(pageIndex);
    const cached = this.pageSvgCache.get(pageIndex);
    if (cached) return cached;
    const start = clockNow();
    const page = this.displayList(pageIndex);
    const width = page.width; const height = page.height;
    const textBoxClips = page.objects.filter((object) => object.kind === "textBox")
      .map((object) => `<clipPath id="text-box-${safeSvgId(object.id)}"><rect x="${object.x.toFixed(2)}" y="${object.y.toFixed(2)}" width="${object.width.toFixed(2)}" height="${object.height.toFixed(2)}"/></clipPath>`).join("");
    const renderLine = (line: DisplayTextLine, textBox?: DisplayDocumentObject) => {
      const clip = textBox ? ` clip-path="url(#text-box-${safeSvgId(textBox.id)})"` : "";
      return `<text x="${line.x.toFixed(2)}" y="${line.y.toFixed(2)}" font-family="${escapeXml(line.fontFamily)}, sans-serif" font-size="${line.fontSize}px" font-weight="${line.bold ? 700 : 400}" font-style="${line.italic ? "italic" : "normal"}" text-decoration="${[line.underline ? "underline" : "", line.strikethrough ? "line-through" : ""].filter(Boolean).join(" ") || "none"}"${line.textLength ? ` textLength="${line.textLength.toFixed(2)}" lengthAdjust="spacing"` : ""} fill="#161616"${clip}>${escapeXml(line.text)}</text>`;
    };
    const linesSvg = page.lines.filter((line) => line.objectControlIndex === undefined).map((line) => renderLine(line)).join("");
    const tableSvg = page.tables.flatMap((table) => table.cells.map((cell) => {
      const fill = cell.properties.fillType === "solid" && typeof cell.properties.fillColor === "string" ? cell.properties.fillColor : "#ffffff";
      const side = (name: "borderLeft" | "borderRight" | "borderTop" | "borderBottom", x1: number, y1: number, x2: number, y2: number) => {
        const border = cell.properties[name];
        const value = typeof border === "object" && border !== null ? border as Record<string, unknown> : {};
        if (value.type === 0 || value.type === "none") return "";
        const color = typeof value.color === "string" ? value.color : "#656565";
        const width = typeof value.width === "number" ? Math.max(0.5, Math.min(4, value.width)) : 0.8;
        return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${escapeXml(color)}" stroke-width="${width.toFixed(2)}"/>`;
      };
      const x2 = cell.x + cell.width; const y2 = cell.y + cell.height;
      return `<rect x="${cell.x.toFixed(2)}" y="${cell.y.toFixed(2)}" width="${cell.width.toFixed(2)}" height="${cell.height.toFixed(2)}" fill="${escapeXml(fill)}" stroke="none"/>${side("borderLeft", cell.x, cell.y, cell.x, y2)}${side("borderRight", x2, cell.y, x2, y2)}${side("borderTop", cell.x, cell.y, x2, cell.y)}${side("borderBottom", cell.x, y2, x2, y2)}`;
    })).join("");
    const renderObject = (object: DisplayDocumentObject) => {
      if (object.kind === "picture" && object.href) {
        return `<image href="${escapeXml(object.href)}" x="${object.x.toFixed(2)}" y="${object.y.toFixed(2)}" width="${object.width.toFixed(2)}" height="${object.height.toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>`;
      }
      const fill = escapeXml(object.fillColor ?? "#ffffff");
      const stroke = escapeXml(object.strokeColor ?? "#202020");
      const strokeWidth = Math.max(0, object.strokeWidth ?? 0.5).toFixed(2);
      const opacity = Math.max(0, Math.min(1, object.opacity ?? 1)).toFixed(3);
      const shape = object.kind === "ellipse"
        ? `<ellipse cx="${(object.x + object.width / 2).toFixed(2)}" cy="${(object.y + object.height / 2).toFixed(2)}" rx="${(object.width / 2).toFixed(2)}" ry="${(object.height / 2).toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`
        : `<rect x="${object.x.toFixed(2)}" y="${object.y.toFixed(2)}" width="${object.width.toFixed(2)}" height="${object.height.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
      if (object.kind !== "textBox") return shape;
      const text = page.lines
        .filter((line) => line.paragraphId === object.paragraphId && line.objectControlIndex === object.controlIndex)
        .map((line) => renderLine(line, object))
        .join("");
      return `${shape}${text}`;
    };
    const orderedObjects = [...page.objects].sort((left, right) => left.zOrder - right.zOrder);
    const behindObjects = orderedObjects.filter((object) => object.textWrap === "BehindText").map(renderObject).join("");
    const frontObjects = orderedObjects.filter((object) => object.textWrap !== "BehindText").map(renderObject).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}px" height="${height}px" viewBox="0 0 ${width} ${height}"><defs>${textBoxClips}</defs><rect x="0" y="0" width="100%" height="100%" fill="#fff" stroke="#b8b8b8"/>${tableSvg}${behindObjects}${linesSvg}${frontObjects}</svg>`;
    this.pageSvgCache.set(pageIndex, svg);
    this._metrics = { ...this._metrics, renderedPageMs: clockNow() - start };
    return svg;
  }

  hitTest(pageIndex: number, x: number, y: number): TextPosition {
    this.requirePage(pageIndex);
    const pageLines = this.pageLineIndex.get(pageIndex) ?? [];
    const objectBox = [...(this.pageObjectIndex.get(pageIndex) ?? [])].reverse().find((item) => item.kind === "textBox"
      && x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
    if (objectBox) {
      const found = this.findObjectById(objectBox.id);
      if (found) {
        const paragraphIndex = indexOf(found.paragraph);
        const textLines = pageLines.filter((line) => line.paragraphId === found.paragraph.id && line.objectControlIndex === found.value.controlIndex);
        if (textLines.length) {
          const closest = textLines.reduce((best, line) => Math.abs(line.y - y) < Math.abs(best.y - y) ? line : best);
          return this.hitTestLine(closest, x);
        }
        return this.positionAtCell(paragraphIndex, 0, 0, 0, pageIndex, found.value.controlIndex);
      }
    }
    for (const table of this.pageTableIndex.get(pageIndex) ?? []) {
      const cell = table.cells.find((item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
      if (!cell) continue;
      const blockIndex = indexOf(this.nodesById.get(table.paragraphId)!);
      const cellLines = pageLines.filter((line) => line.paragraphId === table.paragraphId && line.cellIndex === cell.cellIndex);
      if (!cellLines.length) return this.positionAtCell(blockIndex, cell.cellIndex, 0, 0, pageIndex);
      const closestCellLine = cellLines.reduce((best, line) => Math.abs(line.y - y) < Math.abs(best.y - y) ? line : best);
      return this.hitTestLine(closestCellLine, x);
    }
    if (!pageLines.length) return this.positionAt(0, 0);
    const closest = pageLines.reduce((best, line) => Math.abs(line.y - y) < Math.abs(best.y - y) ? line : best);
    return this.hitTestLine(closest, x);
  }

  private hitTestLine(closest: TextLine, x: number): TextPosition {
    const localX = Math.max(0, x - closest.x);
    let offset = 0; let currentX = 0;
    for (const char of Array.from(closest.text)) {
      const width = measureChar(char, closest.fontSize) * this.visualScale(closest);
      if (localX < currentX + width / 2) break;
      offset += char.length; currentX += width;
    }
    if (closest.objectControlIndex !== undefined) {
      return this.positionAtCell(closest.paragraphIndex, 0, closest.cellParaIndex ?? 0, closest.start + offset, closest.pageIndex, closest.objectControlIndex);
    }
    if (closest.cellIndex !== undefined) {
      return this.positionAtCell(closest.paragraphIndex, closest.cellIndex, closest.cellParaIndex ?? 0, closest.start + offset, closest.pageIndex);
    }
    return this.positionAt(closest.paragraphIndex, closest.start + offset);
  }

  moveCaret(position: TextPosition, delta: -1 | 1): TextPosition {
    if (position.cellPath) {
      const cell = this.cellParagraph(position);
      const offset = Math.max(0, Math.min(cell.paragraph.text.length, position.charOffset));
      if (delta < 0 && offset > 0) {
        const start = isLowSurrogate(cell.paragraph.text.charCodeAt(offset - 1)) && offset > 1 ? offset - 2 : offset - 1;
        return this.positionAtCell(position.parentParagraphIndex!, cell.cellIndex, cell.cellParaIndex, start, undefined, position.cellPath[0].controlIndex);
      }
      if (delta > 0 && offset < cell.paragraph.text.length) {
        const end = isHighSurrogate(cell.paragraph.text.charCodeAt(offset)) && offset + 1 < cell.paragraph.text.length ? offset + 2 : offset + 1;
        return this.positionAtCell(position.parentParagraphIndex!, cell.cellIndex, cell.cellParaIndex, end, undefined, position.cellPath[0].controlIndex);
      }
      if (delta < 0 && offset === 0 && cell.cellParaIndex > 0) {
        const previous = cell.cellParaIndex - 1;
        return this.positionAtCell(position.parentParagraphIndex!, cell.cellIndex, previous, cell.cell.paragraphs[previous].text.length, undefined, position.cellPath[0].controlIndex);
      }
      if (delta > 0 && offset === cell.paragraph.text.length && cell.cellParaIndex + 1 < cell.cell.paragraphs.length) {
        return this.positionAtCell(position.parentParagraphIndex!, cell.cellIndex, cell.cellParaIndex + 1, 0, undefined, position.cellPath[0].controlIndex);
      }
      if (position.cellPath[0].controlIndex !== 0) return position;
      return this.moveTableCell(position, delta);
    }
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
    if (position.cellPath) {
      const cell = position.cellPath[0];
      const matching = current.filter((line) => line.paragraphId === this.blockAt(position.parentParagraphIndex!).id
        && (cell.controlIndex === 0 ? line.cellIndex === cell.cellIndex : line.objectControlIndex === cell.controlIndex));
      const index = matching.findIndex((line) => line.cellParaIndex === cell.cellParaIndex && position.charOffset >= line.start && position.charOffset <= line.end);
      const next = matching[index + delta];
      return next ? this.hitTest(page, position.cursorRect.x, next.y) : this.hitTest(page, position.cursorRect.x, position.cursorRect.y + delta * DEFAULT_LINE_HEIGHT);
    }
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
    if (position.cellPath) {
      const cell = this.cellParagraph(position);
      return this.positionAtCell(position.parentParagraphIndex!, cell.cellIndex, cell.cellParaIndex, edge === "start" ? 0 : cell.paragraph.text.length, undefined, position.cellPath[0].controlIndex);
    }
    const p = at(this.root, this.clampPara(position.paragraphIndex));
    return this.positionAt(indexOf(p), edge === "start" ? 0 : p.text.length);
  }

  insertText(position: TextPosition, text: string): TextPosition { return this.replaceRange(position, position, text); }

  deleteText(position: TextPosition, direction: "backward" | "forward"): TextPosition {
    if (position.cellPath) {
      const cell = this.cellParagraph(position);
      const offset = Math.max(0, Math.min(cell.paragraph.text.length, position.charOffset));
      if (direction === "backward" && offset === 0 || direction === "forward" && offset === cell.paragraph.text.length) return position;
      const start = direction === "backward" ? this.moveCaret(position, -1) : position;
      const end = direction === "backward" ? position : this.moveCaret(position, 1);
      return this.deleteRange(start, end);
    }
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
    return this.restorePosition(entry.beforeCaret);
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
    return this.restorePosition(entry.afterCaret);
  }

  selectionRectangles(start: TextPosition, end: TextPosition): SelectionRectangle[] {
    if (start.cellPath && end.cellPath) {
      if (!sameCell(start, end)) return [];
      const [a, b] = this.ordered(start, end);
      const block = this.blockAt(a.parentParagraphIndex!);
      const cell = this.cellParagraph(a).cell;
      const result: SelectionRectangle[] = [];
      const fromPara = a.cellPath![0].cellParaIndex; const toPara = b.cellPath![0].cellParaIndex;
      for (let cellParaIndex = fromPara; cellParaIndex <= toPara; cellParaIndex += 1) {
        const paragraph = cell.paragraphs[cellParaIndex];
        const from = cellParaIndex === fromPara ? a.charOffset : 0;
        const to = cellParaIndex === toPara ? b.charOffset : paragraph.text.length;
        const controlIndex = a.cellPath![0].controlIndex;
        for (const placed of block.placed.filter((line) => (controlIndex === 0
          ? line.cellIndex === a.cellPath![0].cellIndex : line.objectControlIndex === controlIndex) && line.cellParaIndex === cellParaIndex)) {
          const left = Math.max(from, placed.start); const right = Math.min(to, placed.end);
          if (left >= right && !(from === to && left === right)) continue;
          const scale = this.visualScale(placed);
          const x = placed.x + measureText(paragraph.text.slice(placed.start, left), placed.fontSize) * scale;
          const width = Math.max(2, measureText(paragraph.text.slice(left, Math.max(left, right)), placed.fontSize) * scale);
          result.push({ pageIndex: placed.pageIndex, x, y: placed.y - placed.fontSize, width, height: DEFAULT_LINE_HEIGHT });
        }
      }
      return result;
    }
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
    if (position.cellPath) {
      const { paragraph } = this.cellParagraph(position);
      const run = paragraph.characterFormats.find((r) => position.charOffset >= r.start && position.charOffset < r.end);
      return { fontFamily: "함초롬바탕", fontSize: DEFAULT_FONT_RAW_SIZE, ...run?.format };
    }
    const p = at(this.root, this.clampPara(position.paragraphIndex));
    const run = p.characterFormats.find((r) => position.charOffset >= r.start && position.charOffset < r.end);
    return { fontFamily: "함초롬바탕", fontSize: run?.format.fontSize ?? DEFAULT_FONT_RAW_SIZE, ...run?.format };
  }
  clearTypingFormat(): void { /* The text PoC has no pending-format state. */ }
  applyCharacterFormat(start: TextPosition, end: TextPosition, format: CharacterFormat): TextPosition {
    if (start.cellPath || end.cellPath) {
      if (!start.cellPath || !end.cellPath || !sameCell(start, end)) throw new Error("한 셀 안의 글자만 서식을 바꿀 수 있습니다.");
      const [a, b] = this.ordered(start, end);
      if (a.charOffset === b.charOffset) return a;
      const blockIndex = a.parentParagraphIndex!; const block = this.blockAt(blockIndex); const cell = this.cellParagraph(a);
      const before = this.snapshotBlock(blockIndex, 1);
      cell.paragraph.characterFormats = applyRunFormat(cell.paragraph.characterFormats, a.charOffset, b.charOffset, format);
      this.reflowFrom(blockIndex, new Set([block.id]));
      const after = this.snapshotBlock(blockIndex, 1);
      this.recordSnapshot(blockIndex, before, after, a, a, false);
      return this.positionAtCell(blockIndex, cell.cellIndex, cell.cellParaIndex, a.charOffset, undefined, a.cellPath![0].controlIndex);
    }
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
  paragraphProperties(position: TextPosition): Record<string, unknown> {
    if (position.cellPath) return { ...this.cellParagraph(position).paragraph.paragraphFormat };
    return { ...at(this.root, this.clampPara(position.paragraphIndex)).paragraphFormat };
  }
  applyParagraphFormat(position: TextPosition, format: ParagraphFormat): TextPosition {
    if (position.cellPath) {
      const blockIndex = position.parentParagraphIndex!; const block = this.blockAt(blockIndex); const { paragraph, cellIndex, cellParaIndex } = this.cellParagraph(position);
      const before = this.snapshotBlock(blockIndex, 1);
      paragraph.paragraphFormat = { ...paragraph.paragraphFormat, ...format };
      this.reflowFrom(blockIndex, new Set([block.id]));
      const after = this.snapshotBlock(blockIndex, 1);
      this.recordSnapshot(blockIndex, before, after, position, position, false);
      return this.positionAtCell(blockIndex, cellIndex, cellParaIndex, position.charOffset, undefined, position.cellPath[0].controlIndex);
    }
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
  insertPicture(position: TextPosition, imageData: Uint8Array, extension: string, naturalWidthPx: number, naturalHeightPx: number, widthMm: number, heightMm: number): TextPosition {
    if (position.cellPath) throw new Error("표 셀 또는 글상자 안에 그림을 넣는 기능은 아직 지원하지 않습니다.");
    const normalizedExtension = extension.toLowerCase() === "jpeg" ? "jpg" : extension.toLowerCase();
    if (!(normalizedExtension === "png" || normalizedExtension === "jpg" || normalizedExtension === "gif" || normalizedExtension === "bmp")) throw new Error("PNG, JPEG, GIF, BMP 그림만 넣을 수 있습니다.");
    if (!imageData.length || imageData.length > 50 * 1024 * 1024) throw new Error("그림 파일 크기는 50MB 이하여야 합니다.");
    if (![naturalWidthPx, naturalHeightPx, widthMm, heightMm].every((value) => Number.isFinite(value) && value > 0)) throw new Error("그림의 원본 크기와 배치 크기를 확인하세요.");
    const aspectRatio = naturalWidthPx / naturalHeightPx;
    const object = this.newObject(position, "picture", widthMm, widthMm / aspectRatio);
    object.imageData = imageData.slice();
    object.imageExtension = normalizedExtension;
    object.naturalWidthPx = naturalWidthPx;
    object.naturalHeightPx = naturalHeightPx;
    object.preserveAspectRatio = true;
    return this.addObject(position, object);
  }
  insertShape(position: TextPosition, kind: "rectangle" | "ellipse" | "textBox", widthMm: number, heightMm: number): TextPosition {
    if (position.cellPath) throw new Error("표 셀 또는 글상자 안에 도형을 넣는 기능은 아직 지원하지 않습니다.");
    if (![widthMm, heightMm].every((value) => Number.isFinite(value) && value >= 1)) throw new Error("도형 너비와 높이는 1mm 이상이어야 합니다.");
    const object = this.newObject(position, kind, widthMm, heightMm);
    object.shapeType = kind === "ellipse" ? "ellipse" : "rectangle";
    object.paint = { fillColor: "#ffffff", strokeColor: "#202020", strokeWidth: 0.5, opacity: 1 };
    if (kind === "textBox") {
      object.textParagraphs = [{ text: "", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] }];
      object.textMarginsMm = { left: 2, right: 2, top: 2, bottom: 2 };
    }
    return this.addObject(position, object);
  }
  listObjects(sectionIndex: number): DocumentObject[] {
    if (sectionIndex !== 0) return [];
    return iterate(this.root).flatMap((paragraph) => paragraph.objects.map((object) => ({
      id: object.id, kind: object.kind, sectionIndex: 0, paragraphIndex: indexOf(paragraph), controlIndex: object.controlIndex,
      pageIndex: object.pageIndex, bounds: { ...object.bounds }, zOrder: object.zOrder,
      widthMm: object.widthMm, heightMm: object.heightMm, offsetXmm: object.offsetXmm, offsetYmm: object.offsetYmm,
      textWrap: object.textWrap, treatAsCharacter: object.treatAsCharacter, description: object.description,
    })));
  }
  hitTestObject(pageIndex: number, x: number, y: number): DocumentObject | null {
    this.requirePage(pageIndex);
    const hit = [...(this.pageObjectIndex.get(pageIndex) ?? [])].reverse().find((object) => x >= object.x && x <= object.x + object.width && y >= object.y && y <= object.y + object.height);
    if (!hit) return null;
    return this.listObjects(0).find((object) => object.id === hit.id) ?? null;
  }
  updateObject(object: DocumentObject, updates: DocumentObjectUpdates): TextPosition {
    const found = this.findObjectById(object.id);
    if (!found) throw new Error("편집할 개체가 문서에 없습니다.");
    const current = found.value;
    const next = { ...current, ...updates };
    if (current.kind === "picture" && current.preserveAspectRatio !== false
      && current.naturalWidthPx && current.naturalHeightPx) {
      const ratio = current.naturalWidthPx / current.naturalHeightPx;
      if (updates.widthMm !== undefined) next.heightMm = next.widthMm / ratio;
      else if (updates.heightMm !== undefined) next.widthMm = next.heightMm * ratio;
    }
    if (![next.widthMm, next.heightMm].every((value) => Number.isFinite(value) && value >= 1)) throw new Error("개체의 너비와 높이는 1mm 이상이어야 합니다.");
    if (![next.offsetXmm, next.offsetYmm].every(Number.isFinite)) throw new Error("개체 위치 값을 확인하세요.");
    const wraps: readonly DocumentObjectTextWrap[] = ["Square", "TopAndBottom", "Tight", "Through", "BehindText", "InFrontOfText"];
    if (!wraps.includes(next.textWrap)) throw new Error("지원하지 않는 글 배치 방식입니다.");
    const paragraphIndex = indexOf(found.paragraph);
    const mutationStarted = clockNow();
    const before = this.snapshotBlock(paragraphIndex, 1);
    found.paragraph.objects = found.paragraph.objects.map((entry) => entry.id === current.id ? {
      ...entry, ...updates, widthMm: next.widthMm, heightMm: next.heightMm,
      bounds: { ...entry.bounds, x: next.offsetXmm * PX_PER_MM, y: next.offsetYmm * PX_PER_MM, width: next.widthMm * PX_PER_MM, height: next.heightMm * PX_PER_MM },
    } : entry);
    this._metrics = { ...this._metrics, modelMutationMs: clockNow() - mutationStarted };
    this.reflowFrom(paragraphIndex, new Set([found.paragraph.id]));
    const after = this.snapshotBlock(paragraphIndex, 1);
    const caret = this.positionAt(paragraphIndex, current.anchorCharOffset);
    this.recordSnapshot(paragraphIndex, before, after, caret, caret, false);
    return caret;
  }
  deleteObject(object: DocumentObject): TextPosition {
    const found = this.findObjectById(object.id);
    if (!found) throw new Error("삭제할 개체가 문서에 없습니다.");
    const paragraphIndex = indexOf(found.paragraph);
    const mutationStarted = clockNow();
    const before = this.snapshotBlock(paragraphIndex, 1);
    found.paragraph.objects = found.paragraph.objects.filter((entry) => entry.id !== object.id);
    this._metrics = { ...this._metrics, modelMutationMs: clockNow() - mutationStarted };
    this.reflowFrom(paragraphIndex, new Set([found.paragraph.id]));
    const after = this.snapshotBlock(paragraphIndex, 1);
    const caret = this.positionAt(paragraphIndex, found.value.anchorCharOffset);
    this.recordSnapshot(paragraphIndex, before, after, caret, caret, false);
    return caret;
  }
  setHyperlink(_start: TextPosition, _end: TextPosition, _uri: string): TextPosition { throw unsupported("하이퍼링크"); }
  insertAutoNumber(_position: TextPosition, _kind: "page" | "current" | "total"): TextPosition { throw unsupported("자동 번호"); }
  insertFootnote(_position: TextPosition, _endnote?: boolean): TextPosition { throw unsupported("각주·미주"); }

  deleteRange(start: TextPosition, end: TextPosition): TextPosition { return this.replaceRange(start, end, ""); }
  replaceRange(start: TextPosition, end: TextPosition, text: string): TextPosition {
    if (start.cellPath || end.cellPath) {
      if (!start.cellPath || !end.cellPath || !sameCell(start, end)) throw new Error("한 셀 안의 텍스트만 편집할 수 있습니다.");
      const [a, b] = this.ordered(start, end);
      const aPath = a.cellPath!; const bPath = b.cellPath!;
      const blockIndex = a.parentParagraphIndex!; const block = this.blockAt(blockIndex); const { cell, cellIndex } = this.cellParagraph(a);
      const firstPara = cell.paragraphs[aPath[0].cellParaIndex];
      const lastPara = cell.paragraphs[bPath[0].cellParaIndex];
      const before = this.snapshotBlock(blockIndex, 1);
      const prefix = firstPara.text.slice(0, a.charOffset); const suffix = lastPara.text.slice(b.charOffset);
      const parts = text.replace(/\r\n?/g, "\n").split("\n");
      const inserted: Array<Omit<PlainTextParagraph, "table">> = parts.map((part, index) => {
        const base = index === 0 ? firstPara : index === parts.length - 1 ? lastPara : firstPara;
        const value = parts.length === 1 ? prefix + part + suffix
          : index === 0 ? prefix + part
            : index === parts.length - 1 ? part + suffix : part;
        const runs = index === 0 ? retainRuns(firstPara.characterFormats, 0, a.charOffset) : [];
        if (index === parts.length - 1) runs.push(...retainRuns(lastPara.characterFormats, b.charOffset, lastPara.text.length, part.length));
        return {
          text: value,
          pageBreakBefore: index === 0 ? firstPara.pageBreakBefore : false,
          paragraphFormat: { ...base.paragraphFormat },
          characterFormats: runs,
        };
      });
      cell.paragraphs.splice(aPath[0].cellParaIndex, bPath[0].cellParaIndex - aPath[0].cellParaIndex + 1, ...inserted);
      this.reflowFrom(blockIndex, new Set([block.id]));
      const afterParaIndex = aPath[0].cellParaIndex + inserted.length - 1;
      const afterOffset = inserted[inserted.length - 1].text.length - suffix.length;
      const after = this.snapshotBlock(blockIndex, 1);
      const afterCaret = this.positionAtCell(blockIndex, cellIndex, afterParaIndex, afterOffset, undefined, aPath[0].controlIndex);
      const typing = aPath[0].cellParaIndex === bPath[0].cellParaIndex && a.charOffset === b.charOffset && text.length > 0 && !text.includes("\n");
      this.recordSnapshot(blockIndex, before, after, start, afterCaret, typing);
      return afterCaret;
    }
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
    if (start.cellPath && end.cellPath) {
      if (!sameCell(start, end)) return "";
      const [a, b] = this.ordered(start, end); const cell = this.cellParagraph(a).cell;
      const fromPara = a.cellPath![0].cellParaIndex; const toPara = b.cellPath![0].cellParaIndex;
      return cell.paragraphs.slice(fromPara, toPara + 1).map((paragraph, index) => paragraph.text.slice(
        index === 0 ? a.charOffset : 0,
        index === toPara - fromPara ? b.charOffset : paragraph.text.length,
      )).join("\n");
    }
    const [a, b] = this.ordered(start, end); const parts: string[] = [];
    for (let i = a.paragraphIndex; i <= b.paragraphIndex; i++) { const p = at(this.root, i); parts.push(p.text.slice(i === a.paragraphIndex ? a.charOffset : 0, i === b.paragraphIndex ? b.charOffset : p.text.length)); }
    return parts.join("\n");
  }
  searchText(query: string, options?: SearchOptions | boolean): SearchMatch[] {
    if (!query) return [];
    const caseSensitive = typeof options === "boolean" ? options : options?.caseSensitive ?? false;
    const term = caseSensitive ? query : query.toLocaleLowerCase(); const matches: SearchMatch[] = [];
    for (const p of iterate(this.root)) {
      if (p.table) {
        const blockIndex = indexOf(p);
        p.table.cells.forEach((cell, cellIndex) => cell.paragraphs.forEach((paragraph, cellParaIndex) => {
          const haystack = caseSensitive ? paragraph.text : paragraph.text.toLocaleLowerCase(); let offset = 0;
          while ((offset = haystack.indexOf(term, offset)) >= 0) {
            matches.push({
              start: this.positionAtCell(blockIndex, cellIndex, cellParaIndex, offset),
              end: this.positionAtCell(blockIndex, cellIndex, cellParaIndex, offset + query.length),
              matchedText: paragraph.text.slice(offset, offset + query.length),
            });
            offset += Math.max(query.length, 1);
          }
        }));
      } else {
        const haystack = caseSensitive ? p.text : p.text.toLocaleLowerCase(); let offset = 0;
        while ((offset = haystack.indexOf(term, offset)) >= 0) { matches.push({ start: this.positionAt(indexOf(p), offset), end: this.positionAt(indexOf(p), offset + query.length), matchedText: p.text.slice(offset, offset + query.length) }); offset += Math.max(query.length, 1); }
      }
      for (const object of p.objects) {
        if (object.kind !== "textBox") continue;
        object.textParagraphs?.forEach((paragraph, cellParaIndex) => {
          const haystack = caseSensitive ? paragraph.text : paragraph.text.toLocaleLowerCase(); let offset = 0;
          while ((offset = haystack.indexOf(term, offset)) >= 0) {
            matches.push({
              start: this.positionAtCell(indexOf(p), 0, cellParaIndex, offset, undefined, object.controlIndex),
              end: this.positionAtCell(indexOf(p), 0, cellParaIndex, offset + query.length, undefined, object.controlIndex),
              matchedText: paragraph.text.slice(offset, offset + query.length),
            });
            offset += Math.max(query.length, 1);
          }
        });
      }
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
  createTable(position: TextPosition, rows: number, columns: number): TextPosition {
    if (position.cellPath) throw new Error("표 안에 표를 넣는 기능은 아직 지원하지 않습니다.");
    if (!Number.isInteger(rows) || rows < 1 || rows > 50 || !Number.isInteger(columns) || columns < 1 || columns > 20) {
      throw new Error("표의 행은 1~50, 열은 1~20 범위로 지정하세요.");
    }
    const index = this.clampPara(position.paragraphIndex); const original = at(this.root, index);
    if (original.table) throw new Error("표 바로 안에 다른 표를 넣는 기능은 지원하지 않습니다.");
    const before = this.snapshotBlock(index, 1); const offset = Math.max(0, Math.min(original.text.length, position.charOffset));
    const values: Partial<PlainTextParagraph>[] = [];
    const prefix = original.text.slice(0, offset); const suffix = original.text.slice(offset);
    if (prefix || original.pageBreakBefore) values.push({ ...cloneParagraph(original), text: prefix, characterFormats: retainRuns(original.characterFormats, 0, offset) });
    const tableIndexInValues = values.length;
    values.push({ text: "", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [], table: makeBlankTable(rows, columns, this.contentWidthPx() / PX_PER_MM) });
    values.push({
      text: suffix,
      pageBreakBefore: false,
      paragraphFormat: { ...original.paragraphFormat },
      characterFormats: retainRuns(original.characterFormats, offset, original.text.length, 0),
    });
    this.replaceParagraphBlock(index, 1, values, { ...position, paragraphIndex: index + tableIndexInValues + 1, charOffset: 0 });
    const after = this.snapshotBlock(index, values.length);
    const caret = this.positionAtCell(index + tableIndexInValues, 0, 0, 0);
    this.recordSnapshot(index, before, after, position, caret, false);
    return caret;
  }

  moveTableCell(position: TextPosition, delta: -1 | 1): TextPosition {
    if (!position.cellPath) throw new Error("표 안의 셀을 선택하세요.");
    const tableBlock = this.blockAt(position.parentParagraphIndex!);
    const table = tableBlock.table;
    if (!table) throw new Error("선택한 문단에 표가 없습니다.");
    const current = position.cellPath[0].cellIndex;
    const next = Math.max(0, Math.min(table.cells.length - 1, current + delta));
    return this.positionAtCell(position.parentParagraphIndex!, next, 0, 0);
  }

  editTable(position: TextPosition, command: TableCommand): TextPosition {
    if (!position.cellPath) throw new Error("표 안의 셀을 선택하세요.");
    const blockIndex = position.parentParagraphIndex!; const block = this.blockAt(blockIndex); const table = block.table;
    if (!table) throw new Error("선택한 문단에 표가 없습니다.");
    const cellIndex = position.cellPath[0].cellIndex; const cell = table.cells[cellIndex];
    if (!cell) throw new Error("선택한 표 셀을 찾을 수 없습니다.");
    if ((command === "deleteRow" && table.rowCount <= 1) || (command === "deleteColumn" && table.colCount <= 1)) {
      throw new Error("표의 마지막 행 또는 열은 삭제할 수 없습니다.");
    }
    const before = this.snapshotBlock(blockIndex, 1); let targetRow = cell.row; let targetCol = cell.col;
    switch (command) {
      case "insertRowAbove": insertTableRow(table, cell.row); targetRow++; break;
      case "insertRowBelow": insertTableRow(table, cell.row + cell.rowSpan); targetRow += cell.rowSpan; break;
      case "insertColumnLeft": insertTableColumn(table, cell.col); targetCol++; break;
      case "insertColumnRight": insertTableColumn(table, cell.col + cell.colSpan); targetCol += cell.colSpan; break;
      case "deleteRow": deleteTableRow(table, cell.row); targetRow = Math.min(cell.row, table.rowCount - 1); break;
      case "deleteColumn": deleteTableColumn(table, cell.col); targetCol = Math.min(cell.col, table.colCount - 1); break;
      case "mergeRight": mergeTableCells(table, cellIndex, "right"); break;
      case "mergeDown": mergeTableCells(table, cellIndex, "down"); break;
      case "splitCell": splitTableCell(table, cellIndex); break;
    }
    syncTableDimensions(table);
    const newCellIndex = tableCellIndexAt(table, targetRow, targetCol);
    this.reflowFrom(blockIndex, new Set([block.id]));
    const after = this.snapshotBlock(blockIndex, 1);
    const caret = this.positionAtCell(blockIndex, newCellIndex, 0, 0);
    this.recordSnapshot(blockIndex, before, after, position, caret, false);
    return caret;
  }

  tableLayout(position: TextPosition): TableLayoutInfo {
    if (position.cellPath?.[0].controlIndex !== 0) throw new Error("글상자에는 표 크기 설정을 적용할 수 없습니다.");
    const { cell, cellIndex } = this.cellParagraph(position);
    const table = this.blockAt(position.parentParagraphIndex!).table!;
    const origin = table.cells[cellIndex];
    return {
      widthMm: table.columnWidthsMm.reduce((sum, width) => sum + width, 0),
      offsetXmm: Math.round(Number(table.properties.horzOffset ?? 0) / HWP_UNITS_PER_MM * 1000) / 1000,
      offsetYmm: Math.round(Number(table.properties.vertOffset ?? 0) / HWP_UNITS_PER_MM * 1000) / 1000,
      horizontalAlignment: table.properties.horzAlign === "Center" || table.properties.horzAlign === "Right" ? table.properties.horzAlign : "Left",
      columnWidthMm: table.columnWidthsMm[origin.col],
      rowHeightMm: origin.heightMm / Math.max(1, origin.rowSpan),
      cellPaddingMm: Number(cell.properties.paddingLeft ?? 0) / HWP_UNITS_PER_MM,
      cellFillColor: cell.properties.fillType === "solid" && typeof cell.properties.fillColor === "string" ? cell.properties.fillColor : null,
      cellBorderColor: typeof (cell.properties.borderLeft as Record<string, unknown> | undefined)?.color === "string"
        ? (cell.properties.borderLeft as Record<string, unknown>).color as string : "#000000",
    };
  }

  updateTable(position: TextPosition, updates: TableUpdates): TextPosition {
    if (!position.cellPath) throw new Error("표 셀을 선택하세요.");
    const blockIndex = position.parentParagraphIndex!; const block = this.blockAt(blockIndex); const table = block.table!;
    const cellIndex = position.cellPath[0].cellIndex; const selected = table.cells[cellIndex];
    if (!selected) throw new Error("선택한 표 셀을 찾을 수 없습니다.");
    const numeric = [updates.widthMm, updates.offsetXmm, updates.offsetYmm, updates.columnWidthMm, updates.rowHeightMm, updates.cellPaddingMm]
      .filter((value): value is number => value !== undefined);
    if (numeric.some((value) => !Number.isFinite(value)) || (updates.widthMm !== undefined && updates.widthMm < 10)
      || (updates.columnWidthMm !== undefined && updates.columnWidthMm < 5) || (updates.rowHeightMm !== undefined && updates.rowHeightMm < 2)
      || (updates.cellPaddingMm !== undefined && (updates.cellPaddingMm < 0 || updates.cellPaddingMm > 30))) {
      throw new Error("표 크기, 위치 및 셀 여백 값을 확인하세요.");
    }
    if (updates.columnWidthMm !== undefined && selected.colSpan !== 1) throw new Error("병합 셀에서는 열 너비를 바꿀 수 없습니다.");
    for (const color of [updates.cellFillColor, updates.borderColor]) {
      if (color !== undefined && color !== null && !/^#[0-9a-f]{6}$/iu.test(color)) throw new Error("셀 색상은 6자리 HEX 색상으로 지정하세요.");
    }
    if (updates.horizontalAlignment && !["Left", "Center", "Right"].includes(updates.horizontalAlignment)) throw new Error("표 정렬 값을 확인하세요.");
    const before = this.snapshotBlock(blockIndex, 1);
    if (updates.widthMm !== undefined && updates.columnWidthMm !== undefined) {
      const otherColumns = table.columnWidthsMm.reduce((sum, value, index) => index === selected.col ? sum : sum + value, 0);
      const remainingWidth = updates.widthMm - updates.columnWidthMm;
      if (table.colCount === 1 && Math.abs(remainingWidth) > 0.1) {
        throw new Error("한 열 표에서는 전체 너비와 열 너비를 같게 지정하세요.");
      }
      if (table.colCount > 1 && remainingWidth < (table.colCount - 1) * 5) {
        throw new Error("지정한 전체 너비가 열 너비의 합보다 작습니다.");
      }
      table.columnWidthsMm = table.columnWidthsMm.map((value, index) => index === selected.col
        ? updates.columnWidthMm!
        : value * (table.colCount > 1 ? remainingWidth / Math.max(1, otherColumns) : 1));
    } else if (updates.widthMm !== undefined) {
      const width = table.columnWidthsMm.reduce((sum, value) => sum + value, 0);
      const ratio = updates.widthMm / Math.max(1, width);
      table.columnWidthsMm = table.columnWidthsMm.map((value) => value * ratio);
    } else if (updates.columnWidthMm !== undefined) {
      table.columnWidthsMm[selected.col] = updates.columnWidthMm;
    }
    if (updates.widthMm !== undefined || updates.columnWidthMm !== undefined) {
      table.cells.forEach((cell) => {
        cell.widthMm = table.columnWidthsMm.slice(cell.col, cell.col + cell.colSpan).reduce((sum, value) => sum + value, 0);
        cell.properties.width = Math.round(cell.widthMm * HWP_UNITS_PER_MM);
      });
      table.properties.tableWidth = Math.round(table.columnWidthsMm.reduce((sum, value) => sum + value, 0) * HWP_UNITS_PER_MM);
    }
    if (updates.offsetXmm !== undefined) table.properties.horzOffset = Math.round(updates.offsetXmm * HWP_UNITS_PER_MM);
    if (updates.offsetYmm !== undefined) table.properties.vertOffset = Math.round(updates.offsetYmm * HWP_UNITS_PER_MM);
    if (updates.horizontalAlignment) table.properties.horzAlign = updates.horizontalAlignment;
    if (updates.rowHeightMm !== undefined) {
      selected.heightMm = updates.rowHeightMm * selected.rowSpan;
      selected.properties.height = Math.round(selected.heightMm * HWP_UNITS_PER_MM);
    }
    if (updates.cellPaddingMm !== undefined) {
      const raw = Math.round(updates.cellPaddingMm * HWP_UNITS_PER_MM);
      for (const side of ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"]) selected.properties[side] = raw;
    }
    if (updates.cellFillColor !== undefined) {
      selected.properties.fillType = updates.cellFillColor ? "solid" : "none";
      selected.properties.fillColor = updates.cellFillColor ?? "#ffffff";
    }
    if (updates.borderColor !== undefined) {
      for (const side of ["borderLeft", "borderRight", "borderTop", "borderBottom"]) {
        const border = selected.properties[side];
        selected.properties[side] = { ...(typeof border === "object" && border !== null ? border as Record<string, unknown> : {}), color: updates.borderColor };
      }
    }
    syncTableDimensions(table);
    this.reflowFrom(blockIndex, new Set([block.id]));
    const after = this.snapshotBlock(blockIndex, 1);
    const caret = this.positionAtCell(blockIndex, cellIndex, position.cellPath[0].cellParaIndex, position.charOffset);
    this.recordSnapshot(blockIndex, before, after, position, caret, false);
    return caret;
  }

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

  private newObject(position: TextPosition, kind: DocumentObjectKind, widthMm: number, heightMm: number): PlainTextObject {
    const paragraphIndex = this.clampPara(position.paragraphIndex);
    const controlIndex = this.nextObjectControlIndex++;
    const bounds = {
      pageIndex: position.cursorRect.pageIndex,
      x: position.cursorRect.x,
      y: position.cursorRect.y,
      width: widthMm * PX_PER_MM,
      height: heightMm * PX_PER_MM,
    };
    return {
      id: `0:${paragraphIndex}:${controlIndex}:${kind}`,
      kind, sectionIndex: 0, paragraphIndex, controlIndex,
      pageIndex: position.cursorRect.pageIndex, bounds, zOrder: this.blockAt(paragraphIndex).objects.length,
      widthMm, heightMm, offsetXmm: bounds.x / PX_PER_MM, offsetYmm: bounds.y / PX_PER_MM,
      textWrap: "InFrontOfText", treatAsCharacter: false,
      description: kind === "picture" ? "" : kind === "ellipse" ? "타원" : kind === "textBox" ? "글상자" : "사각형",
      anchorCharOffset: Math.max(0, Math.min(this.blockAt(paragraphIndex).text.length, position.charOffset)),
      properties: {},
    };
  }

  private addObject(position: TextPosition, object: PlainTextObject): TextPosition {
    const paragraphIndex = this.clampPara(position.paragraphIndex);
    const paragraph = this.blockAt(paragraphIndex);
    if (paragraph.table) throw new Error("표 블록에 개체를 삽입하는 기능은 아직 지원하지 않습니다.");
    const mutationStarted = clockNow();
    const before = this.snapshotBlock(paragraphIndex, 1);
    paragraph.objects.push(object);
    this._metrics = { ...this._metrics, modelMutationMs: clockNow() - mutationStarted };
    this.reflowFrom(paragraphIndex, new Set([paragraph.id]));
    const after = this.snapshotBlock(paragraphIndex, 1);
    const caret = this.positionAt(paragraphIndex, object.anchorCharOffset);
    this.recordSnapshot(paragraphIndex, before, after, position, caret, false);
    return caret;
  }

  private findObjectById(id: string): { paragraph: Para; value: PlainTextObject } | null {
    for (const paragraph of iterate(this.root)) {
      const value = paragraph.objects.find((object) => object.id === id);
      if (value) return { paragraph, value };
    }
    return null;
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
      if (p.table) {
        state = this.placeTable(p, state, dirtyPages, placements);
        p.placed = placements; p.endState = { ...state }; refreshUp(p); invalidated++; lastNode = p; changedIds.delete(p.id);
        continue;
      }
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
      this.placeObjects(p, state, dirtyPages, placements);
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
    const blockPages = new Set<number>();
    for (const pageIndex of new Set(p.placed.map((line) => line.pageIndex))) {
      dirtyPages.add(pageIndex);
      blockPages.add(pageIndex);
      const bucket = this.pageLineIndex.get(pageIndex)?.filter((line) => line.paragraphId !== p.id) ?? [];
      if (bucket.length) this.pageLineIndex.set(pageIndex, bucket); else this.pageLineIndex.delete(pageIndex);
    }
    for (const pageIndex of new Set([...blockPages, ...[...this.pageTableIndex].filter(([, fragments]) => fragments.some((fragment) => fragment.paragraphId === p.id)).map(([page]) => page)])) {
      const fragments = this.pageTableIndex.get(pageIndex)?.filter((fragment) => fragment.paragraphId !== p.id) ?? [];
      if (fragments.length) this.pageTableIndex.set(pageIndex, fragments); else this.pageTableIndex.delete(pageIndex);
      dirtyPages.add(pageIndex);
    }
    for (const [pageIndex, objects] of this.pageObjectIndex) {
      const kept = objects.filter((object) => object.paragraphId !== p.id);
      if (kept.length === objects.length) continue;
      dirtyPages.add(pageIndex);
      if (kept.length) this.pageObjectIndex.set(pageIndex, kept); else this.pageObjectIndex.delete(pageIndex);
    }
  }

  private layout(p: Para): void {
    if (p.table) {
      this.layoutTable(p);
      return;
    }
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
    p.flowUnits = p.lines.length;
  }

  private layoutTable(p: Para): void {
    const table = p.table!;
    const fallbackWidth = this.contentWidthPx() / Math.max(1, table.colCount);
    const widths = Array.from({ length: table.colCount }, (_, col) => Math.max(18, (table.columnWidthsMm[col] ?? this.contentWidthPx() / PX_PER_MM / table.colCount) * PX_PER_MM || fallbackWidth));
    const rows: TableRowLayout[] = Array.from({ length: table.rowCount }, (_, row) => ({ row, heightLines: 1, cells: [] }));
    table.cells.forEach((cell, cellIndex) => {
      const cellWidth = widths.slice(cell.col, cell.col + cell.colSpan).reduce((sum, value) => sum + value, 0);
      const paddingLeft = rawCellPaddingToPx(cell.properties.paddingLeft);
      const paddingRight = rawCellPaddingToPx(cell.properties.paddingRight);
      const paddingTop = rawCellPaddingToPx(cell.properties.paddingTop);
      const paddingBottom = rawCellPaddingToPx(cell.properties.paddingBottom);
      const cellLines: TableCellLayoutLine[] = [];
      cell.paragraphs.forEach((paragraph, cellParaIndex) => {
        const left = paragraph.paragraphFormat.marginLeft ?? 0;
        const right = paragraph.paragraphFormat.marginRight ?? 0;
        const indent = paragraph.paragraphFormat.indent ?? 0;
        const available = Math.max(16, cellWidth - paddingLeft - paddingRight - left - right - indent);
        const wrapped = wrapTextParagraph(paragraph, available);
        cellLines.push(...wrapped.map((line, lineIndex) => ({ ...line, cellParaIndex, lineIndex, lineCount: wrapped.length })));
      });
      if (!cellLines.length) cellLines.push({ start: 0, end: 0, text: "", fontSize: DEFAULT_FONT_SIZE, cellParaIndex: 0, lineIndex: 0, lineCount: 1 });
      const minHeight = cell.heightMm * PX_PER_MM;
      const neededLines = Math.max(cellLines.length, Math.ceil((minHeight + paddingTop + paddingBottom) / DEFAULT_LINE_HEIGHT), 1);
      const rowLayout = rows[cell.row];
      rowLayout.cells.push({ cellIndex, lines: cellLines, paddingLeft, paddingRight, paddingTop, paddingBottom });
      rowLayout.heightLines = Math.max(rowLayout.heightLines, Math.ceil(neededLines / Math.max(1, cell.rowSpan)));
    });
    // A merged cell's minimum height applies to its entire span. If content is
    // taller than the current rows, allocate the missing flow units to its last row.
    table.cells.forEach((cell) => {
      const cellLayout = rows[cell.row].cells.find((entry) => entry.cellIndex === table.cells.indexOf(cell));
      if (!cellLayout || cell.rowSpan <= 1) return;
      const required = Math.max(cellLayout.lines.length, Math.ceil((cell.heightMm * PX_PER_MM + cellLayout.paddingTop + cellLayout.paddingBottom) / DEFAULT_LINE_HEIGHT));
      const existing = rows.slice(cell.row, cell.row + cell.rowSpan).reduce((sum, row) => sum + row.heightLines, 0);
      if (required > existing) rows[cell.row + cell.rowSpan - 1].heightLines += required - existing;
    });
    p.tableRows = rows;
    p.lines = [];
    p.flowUnits = rows.reduce((sum, row) => sum + row.heightLines, 0);
  }

  private placeTable(p: Para, initial: FlowState, dirtyPages: Set<number>, placements: TextLine[]): FlowState {
    const table = p.table!; const rows = p.tableRows; const fallbackWidth = this.contentWidthPx() / Math.max(1, table.colCount);
    const widths = Array.from({ length: table.colCount }, (_, col) => Math.max(18, (table.columnWidthsMm[col] ?? this.contentWidthPx() / PX_PER_MM / table.colCount) * PX_PER_MM || fallbackWidth));
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);
    const availableWidth = this.contentWidthPx();
    const horizontalAlignment = table.properties.horzAlign;
    const alignmentOffset = horizontalAlignment === "Center" ? Math.max(0, (availableWidth - tableWidth) / 2)
      : horizontalAlignment === "Right" ? Math.max(0, availableWidth - tableWidth) : 0;
    const tableOriginX = this.pageDefinitionValue.marginLeft * PX_PER_MM + rawCellPaddingToPx(table.properties.outerLeft)
      + alignmentOffset + rawCellPaddingToPx(table.properties.horzOffset);
    const columnX = [tableOriginX];
    for (const width of widths) columnX.push(columnX[columnX.length - 1] + width);
    let state = { ...initial }; const paraIndex = indexOf(p);
    rows.forEach((row) => {
      let remaining = row.heightLines; let rowOffset = 0;
      while (remaining > 0) {
        if (state.line >= this.linesPerPage()) state = { page: state.page + 1, line: 0 };
        const take = Math.min(remaining, this.linesPerPage() - state.line);
        const y = this.contentY() + state.line * DEFAULT_LINE_HEIGHT + rawCellPaddingToPx(table.properties.outerTop)
          + rawCellPaddingToPx(table.properties.vertOffset); const fragmentHeight = take * DEFAULT_LINE_HEIGHT;
        const fragmentCells: DisplayTableCell[] = [];
        table.cells.forEach((cell, cellIndex) => {
          if (cell.row > row.row || cell.row + cell.rowSpan <= row.row) return;
          const x = columnX[cell.col] ?? columnX[0];
          const width = columnX[Math.min(table.colCount, cell.col + cell.colSpan)] - x;
          fragmentCells.push({ cellIndex, row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan, x, y, width, height: fragmentHeight, properties: cell.properties });
        });
        const fragment: DisplayTableFragment = { paragraphId: p.id, pageIndex: state.page, cells: fragmentCells };
        const pageFragments = this.pageTableIndex.get(state.page) ?? [];
        pageFragments.push(fragment); this.pageTableIndex.set(state.page, pageFragments); dirtyPages.add(state.page);

        for (const cellLayout of row.cells) {
          const cell = table.cells[cellLayout.cellIndex];
          const cellWidth = columnX[Math.min(table.colCount, cell.col + cell.colSpan)] - columnX[cell.col];
          const firstLineUnit = Math.floor(cellLayout.paddingTop / DEFAULT_LINE_HEIGHT);
          cellLayout.lines.forEach((line, lineIndex) => {
            const relativeUnit = firstLineUnit + lineIndex;
            if (relativeUnit < rowOffset || relativeUnit >= rowOffset + take) return;
            const localUnit = relativeUnit - rowOffset;
            const cellParagraph = cell.paragraphs[line.cellParaIndex];
            const paragraphFormat = cellParagraph?.paragraphFormat ?? {};
            const left = paragraphFormat.marginLeft ?? 0; const right = paragraphFormat.marginRight ?? 0; const indent = paragraphFormat.indent ?? 0;
            const available = Math.max(16, cellWidth - cellLayout.paddingLeft - cellLayout.paddingRight - left - right - indent);
            const textWidth = measureText(line.text, line.fontSize);
            const alignment = paragraphFormat.alignment ?? "left";
            const x = columnX[cell.col] + cellLayout.paddingLeft + left + indent
              + (alignment === "center" ? Math.max(0, (available - textWidth) / 2) : alignment === "right" ? Math.max(0, available - textWidth) : 0);
            const format = cellParagraph?.characterFormats.find((run) => line.start >= run.start && line.start < run.end)?.format ?? {};
            const justified = alignment === "justify" && line.lineIndex < line.lineCount - 1;
            const placed: TextLine = {
              paragraphIndex: paraIndex,
              paragraphId: p.id,
              cellIndex: cellLayout.cellIndex,
              cellParaIndex: line.cellParaIndex,
              start: line.start,
              end: line.end,
              text: line.text,
              x,
              y: y + localUnit * DEFAULT_LINE_HEIGHT + line.fontSize,
              fontSize: line.fontSize,
              fontFamily: format.fontFamily ?? "함초롬바탕",
              bold: format.bold ?? false,
              italic: format.italic ?? false,
              underline: format.underline ?? false,
              strikethrough: format.strikethrough ?? false,
              ...(justified ? { textLength: available } : {}),
              pageIndex: state.page,
              lineIndex: state.line + localUnit,
            };
            placements.push(placed);
            const bucket = this.pageLineIndex.get(state.page) ?? []; bucket.push(placed); this.pageLineIndex.set(state.page, bucket);
          });
        }
        state = { page: state.page, line: state.line + take };
        rowOffset += take; remaining -= take;
      }
    });
    return state;
  }

  private placeObjects(p: Para, fallbackState: FlowState, dirtyPages: Set<number>, placements: TextLine[]): void {
    if (!p.objects.length) return;
    const bodyLines = placements.filter((line) => line.cellIndex === undefined && line.objectControlIndex === undefined);
    for (const object of p.objects) {
      const anchor = bodyLines.find((line) => object.anchorCharOffset >= line.start && object.anchorCharOffset <= line.end)
        ?? bodyLines[bodyLines.length - 1];
      const pageIndex = anchor?.pageIndex ?? fallbackState.page;
      const x = object.offsetXmm * PX_PER_MM;
      const y = object.offsetYmm * PX_PER_MM;
      const width = object.widthMm * PX_PER_MM;
      const height = object.heightMm * PX_PER_MM;
      object.pageIndex = pageIndex;
      object.bounds = { pageIndex, x, y, width, height };
      const paint = object.paint;
      const href = object.imageData && object.imageExtension
        ? imageDataUri(object.imageData, object.imageExtension)
        : undefined;
      const display: DisplayDocumentObject = {
        id: object.id, paragraphId: p.id, controlIndex: object.controlIndex,
        kind: object.kind, pageIndex, zOrder: object.zOrder,
        x, y, width, height,
        textWrap: object.textWrap,
        ...(href ? { href } : {}),
        ...(paint ? { fillColor: paint.fillColor, strokeColor: paint.strokeColor, strokeWidth: paint.strokeWidth, opacity: paint.opacity } : {}),
      };
      const bucket = this.pageObjectIndex.get(pageIndex) ?? [];
      bucket.push(display);
      bucket.sort((left, right) => left.zOrder - right.zOrder);
      this.pageObjectIndex.set(pageIndex, bucket);
      dirtyPages.add(pageIndex);
      if (object.kind !== "textBox" || !object.textParagraphs?.length) continue;
      const margins = object.textMarginsMm ?? { left: 2, right: 2, top: 2, bottom: 2 };
      const left = margins.left * PX_PER_MM; const right = margins.right * PX_PER_MM;
      const top = margins.top * PX_PER_MM; const bottom = margins.bottom * PX_PER_MM;
      const contentWidth = Math.max(4, width - left - right);
      let lineY = y + top;
      for (let cellParaIndex = 0; cellParaIndex < object.textParagraphs.length; cellParaIndex += 1) {
        const paragraph = object.textParagraphs[cellParaIndex];
        const wrapped = wrapTextParagraph(paragraph, contentWidth);
        for (const line of wrapped) {
          if (lineY + line.fontSize > y + height - bottom) break;
          const format = paragraph.characterFormats.find((run) => line.start >= run.start && line.start < run.end)?.format ?? {};
          const alignment = paragraph.paragraphFormat.alignment ?? "left";
          const textWidth = measureText(line.text, line.fontSize);
          const xOffset = alignment === "center" ? Math.max(0, (contentWidth - textWidth) / 2)
            : alignment === "right" ? Math.max(0, contentWidth - textWidth) : 0;
          const placed: TextLine = {
            paragraphIndex: indexOf(p), paragraphId: p.id, objectControlIndex: object.controlIndex,
            cellParaIndex, start: line.start, end: line.end, text: line.text,
            x: x + left + xOffset, y: lineY + line.fontSize,
            fontSize: line.fontSize, fontFamily: format.fontFamily ?? "함초롬바탕",
            bold: format.bold ?? false, italic: format.italic ?? false,
            underline: format.underline ?? false, strikethrough: format.strikethrough ?? false,
            pageIndex, lineIndex: Math.floor((lineY - this.contentY()) / DEFAULT_LINE_HEIGHT),
          };
          placements.push(placed);
          const lines = this.pageLineIndex.get(pageIndex) ?? [];
          lines.push(placed); this.pageLineIndex.set(pageIndex, lines);
          lineY += DEFAULT_LINE_HEIGHT;
        }
        lineY += DEFAULT_LINE_HEIGHT * 0.25;
      }
    }
  }

  private recordSnapshot(index: number, before: PlainTextParagraph[], after: PlainTextParagraph[], beforeCaret: TextPosition, afterCaret: TextPosition, typing: boolean): void {
    const prior = this.undoStack[this.undoStack.length - 1];
    const sameTypingLocation = prior && (prior.afterCaret.cellPath || beforeCaret.cellPath
      ? sameCell(prior.afterCaret, beforeCaret)
        && prior.afterCaret.cellPath?.[0].cellParaIndex === beforeCaret.cellPath?.[0].cellParaIndex
      : prior.afterCaret.paragraphIndex === beforeCaret.paragraphIndex);
    if (typing && prior?.typing && prior.index === index && sameTypingLocation && prior.afterCaret.charOffset === beforeCaret.charOffset) {
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
    const bodyLines = p.placed.filter((item) => item.objectControlIndex === undefined && item.cellIndex === undefined);
    const line = bodyLines.find((item) => offset >= item.start && offset <= item.end) ?? bodyLines[bodyLines.length - 1];
    const x = line ? line.x + measureText(p.text.slice(line.start, offset), line.fontSize) * this.visualScale(line) : this.contentX(p, "", DEFAULT_FONT_SIZE);
    const y = line?.y ?? this.contentY() + DEFAULT_FONT_SIZE;
    return { sectionIndex: 0, paragraphIndex: i, charOffset: offset, cursorRect: { pageIndex: line?.pageIndex ?? p.startState.page, x, y: y - DEFAULT_FONT_SIZE, height: DEFAULT_LINE_HEIGHT } };
  }
  private positionAtCell(blockIndex: number, cellIndex: number, cellParaIndex: number, charOffset: number, preferredPageIndex?: number, controlIndex = 0): TextPosition {
    const block = this.blockAt(blockIndex);
    const object = controlIndex === 0 ? undefined : block.objects.find((item) => item.controlIndex === controlIndex && item.kind === "textBox");
    const cell: EditableCell | undefined = controlIndex === 0
      ? block.table?.cells[cellIndex]
      : object?.textParagraphs ? { paragraphs: object.textParagraphs, properties: {
        paddingLeft: (object.textMarginsMm?.left ?? 2) * HWP_UNITS_PER_MM,
        paddingRight: (object.textMarginsMm?.right ?? 2) * HWP_UNITS_PER_MM,
        paddingTop: (object.textMarginsMm?.top ?? 2) * HWP_UNITS_PER_MM,
        paddingBottom: (object.textMarginsMm?.bottom ?? 2) * HWP_UNITS_PER_MM,
      } } : undefined;
    if (!cell) throw new RangeError(controlIndex === 0 ? "표 셀 위치를 찾을 수 없습니다." : "글상자 문단 위치를 찾을 수 없습니다.");
    const paragraph = cell.paragraphs[Math.max(0, Math.min(cell.paragraphs.length - 1, cellParaIndex))] ?? { text: "", paragraphFormat: {}, characterFormats: [], pageBreakBefore: false };
    const offset = Math.max(0, Math.min(paragraph.text.length, charOffset));
    const cellLines = block.placed.filter((item) => (controlIndex === 0 ? item.cellIndex === cellIndex : item.objectControlIndex === controlIndex) && item.cellParaIndex === cellParaIndex);
    const preferredLines = preferredPageIndex === undefined ? cellLines : cellLines.filter((item) => item.pageIndex === preferredPageIndex);
    const line = preferredLines.find((item) => item.start === offset)
      ?? preferredLines.find((item) => offset >= item.start && offset <= item.end)
      ?? cellLines.find((item) => item.start === offset)
      ?? cellLines.find((item) => offset >= item.start && offset <= item.end)
      ?? cellLines[0];
    const pageFragments = preferredPageIndex === undefined ? [] : this.pageTableIndex.get(preferredPageIndex) ?? [];
    const cellFragment = controlIndex === 0 ? pageFragments.find((fragment) => fragment.paragraphId === block.id && fragment.cells.some((item) => item.cellIndex === cellIndex))
      ?? [...this.pageTableIndex.values()].flat().find((fragment) => fragment.paragraphId === block.id && fragment.cells.some((item) => item.cellIndex === cellIndex)) : undefined;
    const cellBox = cellFragment?.cells.find((item) => item.cellIndex === cellIndex);
    const paddingLeft = rawCellPaddingToPx(cell.properties.paddingLeft);
    const paddingTop = rawCellPaddingToPx(cell.properties.paddingTop);
    const x = line ? line.x + measureText(paragraph.text.slice(line.start, offset), line.fontSize) * this.visualScale(line)
      : (object?.bounds.x ?? cellBox?.x ?? this.pageDefinitionValue.marginLeft * PX_PER_MM) + paddingLeft;
    const y = line?.y ?? (object?.bounds.y ?? cellBox?.y ?? this.contentY()) + paddingTop + DEFAULT_FONT_SIZE;
    const pageIndex = line?.pageIndex ?? object?.pageIndex ?? cellFragment?.pageIndex ?? block.startState.page;
    return {
      sectionIndex: 0,
      paragraphIndex: cellParaIndex,
      parentParagraphIndex: blockIndex,
      cellPath: [{ controlIndex, cellIndex, cellParaIndex }],
      charOffset: offset,
      cursorRect: { pageIndex, x, y: y - DEFAULT_FONT_SIZE, height: DEFAULT_LINE_HEIGHT },
    };
  }
  private blockAt(index: number): Para { return at(this.root, this.clampPara(index)); }
  private cellParagraph(position: TextPosition): { cell: EditableCell; cellIndex: number; cellParaIndex: number; paragraph: Omit<PlainTextParagraph, "table" | "objects"> } {
    if (!position.cellPath?.length || position.parentParagraphIndex === undefined) throw new Error("표 셀 위치가 아닙니다.");
    const block = this.blockAt(position.parentParagraphIndex); const segment = position.cellPath[0];
    const object = segment.controlIndex === 0 ? undefined : block.objects.find((item) => item.controlIndex === segment.controlIndex && item.kind === "textBox");
    const cell: EditableCell | undefined = segment.controlIndex === 0 ? block.table?.cells[segment.cellIndex]
      : object?.textParagraphs ? { paragraphs: object.textParagraphs, properties: {
        paddingLeft: (object.textMarginsMm?.left ?? 2) * HWP_UNITS_PER_MM,
        paddingRight: (object.textMarginsMm?.right ?? 2) * HWP_UNITS_PER_MM,
        paddingTop: (object.textMarginsMm?.top ?? 2) * HWP_UNITS_PER_MM,
        paddingBottom: (object.textMarginsMm?.bottom ?? 2) * HWP_UNITS_PER_MM,
      } } : undefined;
    const paragraph = cell?.paragraphs[segment.cellParaIndex];
    if (!cell || !paragraph) throw new RangeError("표 셀 문단 위치를 찾을 수 없습니다.");
    return { cell, cellIndex: segment.cellIndex, cellParaIndex: segment.cellParaIndex, paragraph };
  }
  private restorePosition(position: TextPosition): TextPosition {
    return position.cellPath && position.parentParagraphIndex !== undefined
      ? this.positionAtCell(position.parentParagraphIndex, position.cellPath[0].cellIndex, position.cellPath[0].cellParaIndex, position.charOffset, undefined, position.cellPath[0].controlIndex)
      : this.positionAt(position.paragraphIndex, position.charOffset);
  }
  private ordered(a: TextPosition, b: TextPosition): [TextPosition, TextPosition] {
    if (a.cellPath && b.cellPath) {
      if (!sameCell(a, b)) throw new Error("한 셀 안에서만 범위를 선택할 수 있습니다.");
      const ai = a.cellPath[0].cellParaIndex; const bi = b.cellPath[0].cellParaIndex;
      return ai < bi || (ai === bi && a.charOffset <= b.charOffset)
        ? [this.positionAtCell(a.parentParagraphIndex!, a.cellPath[0].cellIndex, ai, a.charOffset, undefined, a.cellPath[0].controlIndex), this.positionAtCell(b.parentParagraphIndex!, b.cellPath[0].cellIndex, bi, b.charOffset, undefined, b.cellPath[0].controlIndex)]
        : [this.positionAtCell(b.parentParagraphIndex!, b.cellPath[0].cellIndex, bi, b.charOffset, undefined, b.cellPath[0].controlIndex), this.positionAtCell(a.parentParagraphIndex!, a.cellPath[0].cellIndex, ai, a.charOffset, undefined, a.cellPath[0].controlIndex)];
    }
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

const HWP_UNITS_PER_MM = 7200 / 25.4;
function rawCellPaddingToPx(value: unknown): number { return typeof value === "number" ? value * 96 / 7200 : 0; }
function sameCell(a: TextPosition, b: TextPosition): boolean {
  return !!a.cellPath && !!b.cellPath && a.parentParagraphIndex === b.parentParagraphIndex
    && a.cellPath[0].controlIndex === b.cellPath[0].controlIndex
    && a.cellPath[0].cellIndex === b.cellPath[0].cellIndex;
}

function wrapTextParagraph(paragraph: Omit<PlainTextParagraph, "table">, maxWidth: number): Array<{ start: number; end: number; text: string; fontSize: number }> {
  const chars = Array.from(paragraph.text); const starts: number[] = []; let utf16 = 0;
  for (const char of chars) { starts.push(utf16); utf16 += char.length; }
  const fontSizeAt = (offset: number) => fontSizePx(paragraph.characterFormats.find((run) => offset >= run.start && offset < run.end)?.format.fontSize ?? DEFAULT_FONT_RAW_SIZE);
  const result: Array<{ start: number; end: number; text: string; fontSize: number }> = [];
  let lineStart = 0; let lineWidth = 0; let lineFontSize = fontSizeAt(0);
  for (let index = 0; index < chars.length; index += 1) {
    const offset = starts[index]; const fontSize = fontSizeAt(offset); const width = measureChar(chars[index], fontSize);
    if (index > lineStart && lineWidth + width > maxWidth) {
      const end = starts[index]; result.push({ start: starts[lineStart], end, text: paragraph.text.slice(starts[lineStart], end), fontSize: lineFontSize });
      lineStart = index; lineWidth = 0; lineFontSize = fontSize;
    }
    lineWidth += width;
  }
  if (!chars.length || lineStart < chars.length) {
    const start = chars.length ? starts[lineStart] : 0;
    result.push({ start, end: paragraph.text.length, text: paragraph.text.slice(start), fontSize: lineFontSize });
  }
  return result;
}

function makeBlankTable(rows: number, columns: number, widthMm: number): PlainTextTable {
  const columnWidth = widthMm / columns; const width = columnWidth * HWP_UNITS_PER_MM;
  const cellProperties = {
    width: Math.round(width), height: Math.round(6 * HWP_UNITS_PER_MM), paddingLeft: 510, paddingRight: 510, paddingTop: 141, paddingBottom: 141,
    verticalAlign: 1, applyInnerMargin: false, borderLeft: { type: 1, width: 1, color: "#000000" },
    borderRight: { type: 1, width: 1, color: "#000000" }, borderTop: { type: 1, width: 1, color: "#000000" },
    borderBottom: { type: 1, width: 1, color: "#000000" }, fillType: "none", fillColor: "#ffffff",
  };
  const tableProperties = {
    cellSpacing: 0, paddingLeft: 510, paddingRight: 510, paddingTop: 141, paddingBottom: 141,
    pageBreak: 0, repeatHeader: false, tableWidth: Math.round(widthMm * HWP_UNITS_PER_MM),
    tableHeight: Math.round(rows * 6 * HWP_UNITS_PER_MM), treatAsChar: false,
    textWrap: "TopAndBottom", horzRelTo: "Para", horzAlign: "Left", vertRelTo: "Para", vertAlign: "Top",
  };
  return {
    rowCount: rows,
    colCount: columns,
    columnWidthsMm: Array(columns).fill(columnWidth),
    properties: tableProperties,
    cells: Array.from({ length: rows * columns }, (_, index) => ({
      row: Math.floor(index / columns), col: index % columns, rowSpan: 1, colSpan: 1,
      widthMm: columnWidth, heightMm: 6, properties: { ...cellProperties },
      paragraphs: [{ text: "", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] }],
    })),
  };
}

function tableCellIndexAt(table: PlainTextTable, row: number, col: number): number {
  const index = table.cells.findIndex((cell) => row >= cell.row && row < cell.row + cell.rowSpan && col >= cell.col && col < cell.col + cell.colSpan);
  if (index < 0) throw new Error("표 격자에 셀이 없습니다.");
  return index;
}

function fillTableGrid(table: PlainTextTable): void {
  const covered = new Set<string>();
  for (const cell of table.cells) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) covered.add(`${row}:${col}`);
    }
  }
  for (let row = 0; row < table.rowCount; row += 1) {
    for (let col = 0; col < table.colCount; col += 1) {
      if (covered.has(`${row}:${col}`)) continue;
      const widthMm = table.columnWidthsMm[col] ?? 30;
      const prototype = table.cells.find((cell) => cell.row === Math.min(row, table.rowCount - 1) && cell.col === Math.min(col, table.colCount - 1)) ?? table.cells[0];
      table.cells.push({
        row, col, rowSpan: 1, colSpan: 1, widthMm, heightMm: prototype?.heightMm ?? 6,
        properties: structuredClone(prototype?.properties ?? {}),
        paragraphs: [{ text: "", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] }],
      });
      covered.add(`${row}:${col}`);
    }
  }
  table.cells.sort((a, b) => a.row - b.row || a.col - b.col);
}

function syncTableDimensions(table: PlainTextTable): void {
  for (const cell of table.cells) {
    cell.widthMm = table.columnWidthsMm.slice(cell.col, cell.col + cell.colSpan).reduce((sum, width) => sum + width, 0);
    cell.properties.width = Math.round(cell.widthMm * HWP_UNITS_PER_MM);
    cell.properties.height = Math.round(cell.heightMm * HWP_UNITS_PER_MM);
  }
  const rowHeights = Array.from({ length: table.rowCount }, () => 0);
  for (const cell of table.cells) {
    const rowHeight = cell.heightMm / Math.max(1, cell.rowSpan);
    for (let row = cell.row; row < Math.min(table.rowCount, cell.row + cell.rowSpan); row += 1) {
      rowHeights[row] = Math.max(rowHeights[row], rowHeight);
    }
  }
  table.properties.tableWidth = Math.round(table.columnWidthsMm.reduce((sum, width) => sum + width, 0) * HWP_UNITS_PER_MM);
  table.properties.tableHeight = Math.round(rowHeights.reduce((sum, height) => sum + height, 0) * HWP_UNITS_PER_MM);
}

function insertTableRow(table: PlainTextTable, index: number): void {
  if (index < 0 || index > table.rowCount) throw new RangeError("행 삽입 위치가 표 범위를 벗어났습니다.");
  for (const cell of table.cells) {
    if (cell.row < index && cell.row + cell.rowSpan > index) cell.rowSpan += 1;
    else if (cell.row >= index) cell.row += 1;
  }
  table.rowCount += 1;
  fillTableGrid(table);
  syncTableDimensions(table);
}

function deleteTableRow(table: PlainTextTable, index: number): void {
  table.cells = table.cells.flatMap((cell) => {
    const end = cell.row + cell.rowSpan;
    if (index < cell.row) return [{ ...cell, row: cell.row - 1 }];
    if (index >= end) return [cell];
    if (cell.rowSpan <= 1) return [];
    return [{ ...cell, row: cell.row === index ? cell.row : cell.row, rowSpan: cell.rowSpan - 1 }];
  });
  table.rowCount -= 1;
  fillTableGrid(table);
  syncTableDimensions(table);
}

function insertTableColumn(table: PlainTextTable, index: number): void {
  if (index < 0 || index > table.colCount) throw new RangeError("열 삽입 위치가 표 범위를 벗어났습니다.");
  const tableWidth = table.columnWidthsMm.reduce((sum, columnWidth) => sum + columnWidth, 0);
  const sourceColumn = Math.max(0, Math.min(index - 1, table.colCount - 1));
  const sourceWidth = table.columnWidthsMm[sourceColumn] ?? 30;
  const width = sourceWidth / 2;
  table.columnWidthsMm[sourceColumn] = sourceWidth - width;
  table.columnWidthsMm.splice(index, 0, width);
  const expandedWidth = table.columnWidthsMm.reduce((sum, columnWidth) => sum + columnWidth, 0);
  const scale = tableWidth / Math.max(1, expandedWidth);
  table.columnWidthsMm = table.columnWidthsMm.map((columnWidth) => columnWidth * scale);
  for (const cell of table.cells) {
    if (cell.col < index && cell.col + cell.colSpan > index) cell.colSpan += 1;
    else if (cell.col >= index) cell.col += 1;
  }
  table.colCount += 1;
  fillTableGrid(table);
  syncTableDimensions(table);
}

function deleteTableColumn(table: PlainTextTable, index: number): void {
  const tableWidth = table.columnWidthsMm.reduce((sum, columnWidth) => sum + columnWidth, 0);
  table.cells = table.cells.flatMap((cell) => {
    const end = cell.col + cell.colSpan;
    if (index < cell.col) return [{ ...cell, col: cell.col - 1 }];
    if (index >= end) return [cell];
    if (cell.colSpan <= 1) return [];
    return [{ ...cell, col: cell.col === index ? cell.col : cell.col, colSpan: cell.colSpan - 1 }];
  });
  table.columnWidthsMm.splice(index, 1); table.colCount -= 1;
  const remainingWidth = table.columnWidthsMm.reduce((sum, columnWidth) => sum + columnWidth, 0);
  if (remainingWidth > 0) {
    const scale = tableWidth / remainingWidth;
    table.columnWidthsMm = table.columnWidthsMm.map((columnWidth) => columnWidth * scale);
  }
  fillTableGrid(table);
  syncTableDimensions(table);
}

function mergeTableCells(table: PlainTextTable, cellIndex: number, direction: "right" | "down"): void {
  const cell = table.cells[cellIndex]; if (!cell) throw new Error("선택한 셀을 찾을 수 없습니다.");
  const neighborIndex = table.cells.findIndex((other, index) => index !== cellIndex && (direction === "right"
    ? other.row === cell.row && other.rowSpan === cell.rowSpan && other.col === cell.col + cell.colSpan
    : other.col === cell.col && other.colSpan === cell.colSpan && other.row === cell.row + cell.rowSpan));
  if (neighborIndex < 0) throw new Error("병합할 인접 셀을 찾을 수 없습니다.");
  const neighbor = table.cells[neighborIndex];
  cell.paragraphs.push(...neighbor.paragraphs.map((paragraph) => ({ ...paragraph, paragraphFormat: { ...paragraph.paragraphFormat }, characterFormats: paragraph.characterFormats.map((run) => ({ ...run, format: { ...run.format } })) })));
  if (direction === "right") cell.colSpan += neighbor.colSpan; else cell.rowSpan += neighbor.rowSpan;
  cell.widthMm += neighbor.widthMm; cell.heightMm = Math.max(cell.heightMm, neighbor.heightMm);
  table.cells.splice(neighborIndex, 1);
}

function splitTableCell(table: PlainTextTable, cellIndex: number): void {
  const cell = table.cells[cellIndex]; if (!cell) throw new Error("선택한 셀을 찾을 수 없습니다.");
  if (cell.rowSpan === 1 && cell.colSpan === 1) throw new Error("이 셀은 병합된 셀이 아닙니다.");
  const originalWidth = cell.widthMm / cell.colSpan; const originalHeight = cell.heightMm / cell.rowSpan;
  const rowEnd = cell.row + cell.rowSpan; const colEnd = cell.col + cell.colSpan;
  cell.rowSpan = 1; cell.colSpan = 1; cell.widthMm = originalWidth; cell.heightMm = originalHeight;
  for (let row = cell.row; row < rowEnd; row += 1) {
    for (let col = cell.col; col < colEnd; col += 1) {
      if (row === cell.row && col === cell.col) continue;
      table.cells.push({ row, col, rowSpan: 1, colSpan: 1, widthMm: originalWidth, heightMm: originalHeight, properties: structuredClone(cell.properties), paragraphs: [{ text: "", pageBreakBefore: false, paragraphFormat: {}, characterFormats: [] }] });
    }
  }
  table.cells.sort((a, b) => a.row - b.row || a.col - b.col);
}
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
function safeSvgId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/gu, "-"); }
function imageDataUri(data: Uint8Array, extension: string): string {
  const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "gif" ? "image/gif" : extension === "bmp" ? "image/bmp" : "image/png";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < data.length; index += 3) {
    const a = data[index] ?? 0; const hasB = index + 1 < data.length; const hasC = index + 2 < data.length;
    const b = hasB ? data[index + 1]! : 0; const c = hasC ? data[index + 2]! : 0;
    encoded += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)]
      + (hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : "=") + (hasC ? alphabet[c & 63] : "=");
  }
  return `data:${mime};base64,${encoded}`;
}
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function unsupported(feature: string): Error { return new Error(`${feature}은 새 문서 엔진에서 아직 지원되지 않습니다. 기존 HWP/HWPX 문서를 열거나 RHWP 호환성 엔진을 사용하세요.`); }
function clockNow(): number { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

export const emptyContentLossReport = (format: "hwp" | "hwpx"): ContentLossReport => ({ schemaVersion: 1, outputFormat: format, count: 0, losses: [] });
