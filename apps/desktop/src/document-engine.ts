/** Renderer and editor-facing document contract, independent of a file-format library. */
export interface CursorRectangle {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

export interface TextPosition {
  sectionIndex: number;
  /** Body paragraph index, or table-cell paragraph index. */
  paragraphIndex: number;
  charOffset: number;
  cursorRect: CursorRectangle;
  parentParagraphIndex?: number;
  cellPath?: CellPathSegment[];
}

export interface CellPathSegment {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

export interface SelectionRectangle {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CharacterFormat {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface ParagraphFormat {
  alignment?: "left" | "center" | "right" | "justify";
  lineSpacing?: number;
  lineSpacingType?: "Percent" | "Fixed" | "AtLeast";
  marginLeft?: number;
  marginRight?: number;
  indent?: number;
  spacingBefore?: number;
  spacingAfter?: number;
}

export interface PageDefinition {
  /** Physical page dimensions and margins in millimeters. */
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  marginHeader: number;
  marginFooter: number;
  marginGutter: number;
  landscape: boolean;
  binding: number;
}

export interface DocumentInfo {
  version?: string;
  sectionCount?: number;
  pageCount?: number;
  encrypted?: boolean;
  hwp3Variant?: boolean;
  fontsUsed?: string[];
  fontSubstitutions?: unknown[];
}

export interface RenderedPageInfo {
  pageIndex: number;
  pageNumber: number;
  width: number;
  height: number;
  sectionIndex: number;
}

export interface DocumentStyle {
  id: number;
  name: string;
  englishName?: string;
  type?: string;
  paraShapeId?: number;
  charShapeId?: number;
}

export interface ContentLossItem {
  code?: string;
  subject?: string;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ContentLossReport {
  schemaVersion: number;
  outputFormat: "hwp" | "hwpx";
  count: number;
  losses: ContentLossItem[];
}

export interface ExportResult {
  bytes: Uint8Array;
  report: ContentLossReport;
}

/** Optional stage timings exposed by engines without exposing their internal document model. */
export interface DocumentPerformanceMetrics {
  modelMutationMs: number;
  incrementalLayoutMs: number;
  invalidatedParagraphs: number;
  invalidatedPages: number;
  renderedPageMs: number;
}

export interface SearchMatch {
  start: TextPosition;
  end: TextPosition;
  matchedText: string;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  includeCells?: boolean;
}

export type HeaderFooterScope = "currentPage" | "bothPages" | "evenPages" | "oddPages";
export type HeaderFooterFieldKind = "pageNumber" | "totalPages" | "fileName";

export interface HeaderFooterInfo {
  sectionIndex: number;
  applyTo: number;
  exists: boolean;
  text: string;
}

export type DocumentObjectKind = "picture" | "rectangle" | "ellipse" | "textBox";
export type DocumentObjectTextWrap = "Square" | "TopAndBottom" | "Tight" | "Through" | "BehindText" | "InFrontOfText";

/** A stable, engine-owned handle to an editable object in the document model. */
export interface DocumentObject {
  id: string;
  kind: DocumentObjectKind;
  sectionIndex: number;
  paragraphIndex: number;
  controlIndex: number;
  pageIndex: number;
  bounds: SelectionRectangle;
  zOrder: number;
  widthMm: number;
  heightMm: number;
  offsetXmm: number;
  offsetYmm: number;
  textWrap: DocumentObjectTextWrap;
  treatAsCharacter: boolean;
  description: string;
}

export interface DocumentObjectUpdates {
  widthMm?: number;
  heightMm?: number;
  offsetXmm?: number;
  offsetYmm?: number;
  textWrap?: DocumentObjectTextWrap;
  treatAsCharacter?: boolean;
  description?: string;
}

export type TableCommand =
  | "insertRowAbove"
  | "insertRowBelow"
  | "insertColumnLeft"
  | "insertColumnRight"
  | "deleteRow"
  | "deleteColumn"
  | "mergeRight"
  | "mergeDown"
  | "splitCell";

export interface TableLayoutInfo {
  widthMm: number;
  offsetXmm: number;
  offsetYmm: number;
  horizontalAlignment: "Left" | "Center" | "Right";
  columnWidthMm: number;
  rowHeightMm: number;
  cellPaddingMm: number;
  cellFillColor: string | null;
  cellBorderColor: string;
}

export interface TableUpdates {
  widthMm?: number;
  offsetXmm?: number;
  offsetYmm?: number;
  horizontalAlignment?: "Left" | "Center" | "Right";
  columnWidthMm?: number;
  rowHeightMm?: number;
  cellPaddingMm?: number;
  cellFillColor?: string | null;
  borderColor?: string;
}

export type HeaderFooterKind = "header" | "footer";

/**
 * Semantic operations used by the desktop UI. Implementations own parsing,
 * layout, mutation, undo/redo and serialization; the UI never sees engine internals.
 */
export interface DocumentSession {
  /** Stable identifier for capability-aware UI; omitted by legacy adapters. */
  readonly engineId?: string;
  readonly pageCount: number;
  readonly sourceFormat: string;
  /** Page-local render invalidation counter; absent on legacy engines. */
  renderRevision?(pageIndex: number): number;
  /** Latest synchronous stage timings where an engine can measure them. */
  performanceMetrics?(): Readonly<DocumentPerformanceMetrics>;
  documentInfo(): DocumentInfo;
  pageInfo(pageIndex: number): RenderedPageInfo;
  renderPage(pageIndex: number): string;
  hitTest(pageIndex: number, x: number, y: number): TextPosition;
  moveCaret(position: TextPosition, delta: -1 | 1): TextPosition;
  moveCaretVertical(position: TextPosition, delta: -1 | 1): TextPosition;
  moveCaretToParagraphEdge(position: TextPosition, edge: "start" | "end"): TextPosition;
  insertText(position: TextPosition, text: string): TextPosition;
  deleteText(position: TextPosition, direction: "backward" | "forward"): TextPosition;
  splitParagraph(position: TextPosition): TextPosition;
  insertPageBreak(position: TextPosition): TextPosition;
  undo(): TextPosition | null;
  redo(): TextPosition | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  selectionRectangles(start: TextPosition, end: TextPosition): SelectionRectangle[];
  characterProperties(position: TextPosition): Record<string, unknown>;
  clearTypingFormat(): void;
  applyCharacterFormat(start: TextPosition, end: TextPosition, format: CharacterFormat): TextPosition;
  paragraphProperties(position: TextPosition): Record<string, unknown>;
  applyParagraphFormat(position: TextPosition, format: ParagraphFormat): TextPosition;
  applyParagraphAlignment(position: TextPosition, alignment: "left" | "center" | "right" | "justify"): TextPosition;
  styleList(): DocumentStyle[];
  applyStyle(position: TextPosition, styleId: number): TextPosition;
  pageDefinition(sectionIndex: number): PageDefinition;
  setPageDefinition(position: TextPosition, updates: Partial<PageDefinition>): TextPosition;
  insertHeaderFooterText(position: TextPosition, kind: HeaderFooterKind, text: string): TextPosition;
  headerFooterInfo(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope): HeaderFooterInfo;
  setHeaderFooterText(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope, text: string): TextPosition;
  deleteHeaderFooter(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope): TextPosition;
  insertHeaderFooterField(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope, field: HeaderFooterFieldKind): TextPosition;
  insertPicture(position: TextPosition, imageData: Uint8Array, extension: string, naturalWidthPx: number, naturalHeightPx: number, widthMm: number, heightMm: number): TextPosition;
  insertShape(position: TextPosition, kind: "rectangle" | "ellipse" | "textBox", widthMm: number, heightMm: number): TextPosition;
  listObjects(sectionIndex: number): DocumentObject[];
  hitTestObject(pageIndex: number, x: number, y: number): DocumentObject | null;
  updateObject(object: DocumentObject, updates: DocumentObjectUpdates): TextPosition;
  deleteObject(object: DocumentObject): TextPosition;
  setHyperlink(start: TextPosition, end: TextPosition, uri: string): TextPosition;
  insertAutoNumber(position: TextPosition, kind: "page" | "current" | "total"): TextPosition;
  insertFootnote(position: TextPosition, endnote?: boolean): TextPosition;
  deleteRange(start: TextPosition, end: TextPosition): TextPosition;
  replaceRange(start: TextPosition, end: TextPosition, text: string): TextPosition;
  selectedText(start: TextPosition, end: TextPosition): string;
  searchText(query: string, options?: SearchOptions | boolean): SearchMatch[];
  replaceAllText(query: string, replacement: string, options?: SearchOptions | boolean): { count: number; position: TextPosition | null };
  createTable(position: TextPosition, rows: number, columns: number): TextPosition;
  moveTableCell(position: TextPosition, delta: -1 | 1): TextPosition;
  editTable(position: TextPosition, command: TableCommand): TextPosition;
  tableLayout(position: TextPosition): TableLayoutInfo;
  updateTable(position: TextPosition, updates: TableUpdates): TextPosition;
  exportWithReport(format?: "hwp" | "hwpx"): ExportResult;
  dispose(): void;
}

/** File-format adapter contract. New engines can be introduced behind this API. */
export interface DocumentEngine {
  readonly id: string;
  open(bytes: Uint8Array): Promise<DocumentSession>;
  createBlank(): Promise<DocumentSession>;
}
