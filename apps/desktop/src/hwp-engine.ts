import init, { HwpDocument, type DocumentExport } from "@rhwp/core";
import wasmUrl from "@rhwp/core/rhwp_bg.wasm?url";
import type {
  CellPathSegment,
  CharacterFormat,
  ContentLossReport,
  CursorRectangle,
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
import { HanulTextDocumentSession, type ImportedPlainTextDocument, type PlainTextObject, type PlainTextParagraph, type PlainTextSerializer, type PlainTextTable, type PlainTextTableCell } from "./text-document-engine";

export type {
  CellPathSegment,
  CharacterFormat,
  ContentLossItem,
  ContentLossReport,
  CursorRectangle,
  DocumentEngine,
  DocumentInfo,
  DocumentSession,
  DocumentStyle,
  ExportResult,
  HeaderFooterKind,
  PageDefinition,
  ParagraphFormat,
  RenderedPageInfo,
  SearchMatch,
  SelectionRectangle,
  TableCommand,
  TextPosition,
} from "./document-engine";

type RhwpGlobals = typeof globalThis & {
  measureTextWidth?: (font: string, text: string) => number;
};

interface RawHit extends Omit<TextPosition, "cursorRect"> {
  cursorRect?: CursorRectangle;
  isTextBox?: boolean;
  isField?: boolean;
  cellPath?: CellPathSegment[];
  parentParaIndex?: number;
}

type EditOperation =
  | { kind: "insert"; address: TextPosition; text: string; format?: Record<string, unknown> }
  | { kind: "delete"; address: TextPosition; text: string; charRuns?: string }
  | { kind: "split"; address: TextPosition; removedParaMeta?: string }
  | { kind: "merge"; address: TextPosition; charOffset: number; caretAfterUndo: "start" | "merge"; removedParaMeta?: string }
  | { kind: "char-format"; address: TextPosition; start: number; end: number; before: string; after: string }
  | { kind: "para-align"; address: TextPosition; before: string; after: string }
  | { kind: "table"; address: TextPosition; rows: number; columns: number; tableParaIndex: number; controlIndex: number }
  | { kind: "snapshot"; beforeSnapshotId: number; afterSnapshotId: number; beforeAddress: TextPosition; afterAddress: TextPosition; preserveCursorRect?: boolean }
  | { kind: "compound"; operations: EditOperation[] };

interface RawSearchHit {
  sec: number;
  para: number;
  charOffset: number;
  length: number;
  cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number };
  cellPath?: CellPathSegment[];
  equationControl?: number;
}

interface RawDocumentObject {
  para: number;
  controlIndex: number;
  kind: string;
  listId?: number | null;
}

interface RawObjectCycle {
  para: number;
  controlIndex: number;
  page: number;
  z?: number;
}

interface RawEditableObjectProperties {
  width?: number;
  height?: number;
  horzOffset?: number;
  vertOffset?: number;
  textWrap?: string;
  treatAsChar?: boolean;
  description?: string;
}

interface RawDocumentControl {
  ctrlId?: string;
  para?: number;
  controlIndex?: number;
  pos?: number;
  list?: number;
}

interface RawLayerTreeNode {
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  layer?: { stableIndex?: number; zOrder?: number; textWrap?: string };
  ops?: Array<Record<string, unknown>>;
  children?: RawLayerTreeNode[];
  child?: RawLayerTreeNode;
}

interface RawObjectLayer {
  pageIndex: number;
  stableIndex: number;
  zOrder: number;
  textWrap: string;
  bounds: { x: number; y: number; width: number; height: number };
  op: Record<string, unknown>;
}

const OBJECT_TEXT_WRAPS: readonly DocumentObjectTextWrap[] = [
  "Square", "TopAndBottom", "Tight", "Through", "BehindText", "InFrontOfText",
];
// RHWP geometry and page definitions use 1/7200-inch units. Keep the
// conversion inside the engine adapter so the UI deals only in millimeters.
const RHWP_OBJECT_UNITS_PER_MM = 7200 / 25.4;
const RHWP_PAGE_UNITS_PER_MM = RHWP_OBJECT_UNITS_PER_MM;

function rhwpUnitsToMillimeters(value: number) {
  return Math.round(value / RHWP_OBJECT_UNITS_PER_MM * 1000) / 1000;
}

function normalizeSearchOptions(options?: SearchOptions | boolean): Required<SearchOptions> {
  if (typeof options === "boolean") return { caseSensitive: false, includeCells: options };
  return { caseSensitive: options?.caseSensitive ?? false, includeCells: options?.includeCells ?? true };
}

function objectTextWrap(value: string | undefined): DocumentObjectTextWrap {
  return OBJECT_TEXT_WRAPS.find((wrap) => wrap === value) ?? "Square";
}

let initialization: Promise<void> | undefined;
let initializationDurationMs = 0;
let initializationRuns = 0;

const MAX_CACHED_RENDERED_PAGES = 12;

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function reportEnginePerformance(details: Record<string, string | number | boolean>) {
  if (import.meta.env.DEV) console.info("[Hanul performance] RHWP", details);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function unsupportedDifferenceKeys(actual: Record<string, unknown>, baseline: Record<string, unknown>, supported: ReadonlySet<string>): string[] {
  const keys = new Set([...Object.keys(actual), ...Object.keys(baseline)]);
  return [...keys].filter((key) => !supported.has(key) && stableJson(actual[key]) !== stableJson(baseline[key]));
}

function hasOnlySupportedDifferences(actual: Record<string, unknown>, baseline: Record<string, unknown>, supported: ReadonlySet<string>): boolean {
  return unsupportedDifferenceKeys(actual, baseline, supported).length === 0;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("문서 엔진의 " + label + " 응답을 읽지 못했습니다.");
  }
}

function registerTextMeasurement() {
  const runtime = globalThis as RhwpGlobals;
  if (typeof document === "undefined") {
    runtime.measureTextWidth = (_font, text) => text.length * 8;
    return;
  }
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  let activeFont = "";

  runtime.measureTextWidth = (font, text) => {
    if (!canvas) {
      canvas = document.createElement("canvas");
      context = canvas.getContext("2d");
    }
    if (!context) return text.length * 8;
    if (activeFont !== font) {
      context.font = font;
      activeFont = font;
    }
    return context.measureText(text).width;
  };
}

function initializeEngine() {
  if (!initialization) {
    initializationRuns += 1;
    registerTextMeasurement();
    const startedAt = now();
    initialization = init({ module_or_path: wasmUrl }).then(() => {
      initializationDurationMs = now() - startedAt;
    });
  }
  return initialization;
}

class RhwpDocumentSession implements DocumentSession {
  private readonly document: HwpDocument;
  private readonly renderedPages = new Map<number, string>();
  private readonly undoStack: EditOperation[] = [];
  private readonly redoStack: EditOperation[] = [];
  private typingFormat: CharacterFormat = {};
  readonly sourceFormat: string;

  constructor(document: HwpDocument) {
    this.document = document;
    this.sourceFormat = document.getSourceFormat().toLowerCase();
    if (this.pageCount < 1) {
      document.free();
      throw new Error("문서에서 페이지를 찾지 못했습니다.");
    }
  }

  get pageCount() {
    return this.document.pageCount();
  }

  documentInfo() {
    return parseJson<DocumentInfo>(this.document.getDocumentInfo(), "문서 정보");
  }

  pageInfo(pageIndex: number) {
    if (pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new RangeError("페이지 번호가 문서 범위를 벗어났습니다.");
    }
    return parseJson<RenderedPageInfo>(this.document.getPageInfo(pageIndex), "쪽 정보");
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  renderPage(pageIndex: number) {
    if (pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new RangeError("페이지 번호가 문서 범위를 벗어났습니다.");
    }
    const cached = this.renderedPages.get(pageIndex);
    if (cached !== undefined) {
      this.renderedPages.delete(pageIndex);
      this.renderedPages.set(pageIndex, cached);
      return cached;
    }
    const svg = this.document.renderPageSvg(pageIndex);
    this.renderedPages.set(pageIndex, svg);
    if (this.renderedPages.size > MAX_CACHED_RENDERED_PAGES) {
      const leastRecentlyUsedPage = this.renderedPages.keys().next().value;
      if (leastRecentlyUsedPage !== undefined) this.renderedPages.delete(leastRecentlyUsedPage);
    }
    return svg;
  }

  hitTest(pageIndex: number, x: number, y: number): TextPosition {
    const headerFooter = parseJson<{ hit?: boolean }>(
      this.document.hitTestHeaderFooter(pageIndex, x, y),
      "머리말/꼬리말 위치",
    );
    if (headerFooter.hit) {
      throw new Error("머리말과 꼬리말은 아직 편집할 수 없습니다.");
    }

    const footnote = parseJson<{ hit?: boolean }>(
      this.document.hitTestFootnote(pageIndex, x, y),
      "각주 위치",
    );
    if (footnote.hit) {
      throw new Error("각주와 미주는 아직 편집할 수 없습니다.");
    }

    const hit = parseJson<RawHit>(this.document.hitTest(pageIndex, x, y), "문자 위치");
    if (hit.isField || (hit.isTextBox && !hit.cellPath?.length)) {
      throw new Error("필드 내부 텍스트를 편집할 수 없습니다.");
    }
    if (
      !Number.isInteger(hit.sectionIndex) ||
      !Number.isInteger(hit.paragraphIndex) ||
      !Number.isInteger(hit.charOffset)
    ) {
      throw new Error("편집할 본문 문자를 찾지 못했습니다.");
    }

    if (hit.cellPath?.length) {
      const cellPath = hit.cellPath.map((segment) => ({ ...segment }));
      const paragraphIndex = cellPath[cellPath.length - 1].cellParaIndex;
      return this.positionAt(
        hit.sectionIndex,
        paragraphIndex,
        hit.charOffset,
        hit.cursorRect,
        hit.parentParaIndex,
        cellPath,
      );
    }
    return this.positionAt(hit.sectionIndex, hit.paragraphIndex, hit.charOffset, hit.cursorRect);
  }

  moveCaret(position: TextPosition, delta: -1 | 1) {
    const length = this.paragraphLength(position);
    const nextOffset = position.charOffset + delta;
    if (nextOffset >= 0 && nextOffset <= length) {
      return this.positionAtAddress(position, nextOffset);
    }
    const paragraphCount = this.paragraphCount(position);
    if (delta < 0 && position.paragraphIndex > 0) {
      const previousParagraph = position.paragraphIndex - 1;
      const previous = this.addressAtParagraph(position, previousParagraph);
      const previousLength = this.paragraphLength(previous);
      return this.positionAtAddress(previous, previousLength);
    }
    if (delta > 0 && position.paragraphIndex + 1 < paragraphCount) {
      return this.positionAtAddress(this.addressAtParagraph(position, position.paragraphIndex + 1), 0);
    }
    return position;
  }

  moveCaretVertical(position: TextPosition, delta: -1 | 1) {
    const lineHeight = Math.max(12, position.cursorRect.height);
    return this.hitTest(
      position.cursorRect.pageIndex,
      position.cursorRect.x,
      position.cursorRect.y + lineHeight * delta,
    );
  }

  moveCaretToParagraphEdge(position: TextPosition, edge: "start" | "end") {
    return this.positionAtAddress(position, edge === "start" ? 0 : this.paragraphLength(position));
  }

  insertText(position: TextPosition, text: string) {
    if (!text) return position;
    const format = this.toRhwpFormat(this.typingFormat);
    const next = this.applyInsert(position, text, format);
    this.undoStack.push({
      kind: "insert",
      address: { ...position },
      text,
      format: Object.keys(format).length ? format : undefined,
    });
    this.clearRedo();
    return next;
  }

  deleteText(position: TextPosition, direction: "backward" | "forward") {
    const length = this.paragraphLength(position);
    const charOffset = direction === "backward" ? position.charOffset - 1 : position.charOffset;
    if (charOffset < 0) {
      if (position.paragraphIndex <= 0) return position;
      return this.mergeParagraph(position, "start");
    }
    if (charOffset >= length) {
      if (direction === "forward" && position.paragraphIndex + 1 < this.paragraphCount(position)) {
        return this.mergeParagraph(this.addressAtParagraph(position, position.paragraphIndex + 1), "merge");
      }
      return position;
    }

    const address = this.positionAtAddress(position, charOffset);
    const removed = this.readTextRange(address, charOffset, charOffset + 1);
    if (!removed) return position;
    const charRuns = this.getCharRuns(address, charOffset, charOffset + 1);

    const result = this.deleteTextRange(address, charOffset, charOffset + 1);
    if (!result.ok) throw new Error("문자를 삭제하지 못했습니다.");
    this.undoStack.push({
      kind: "delete",
      address,
      text: removed,
      charRuns,
    });
    this.clearRedo();
    this.invalidatePages(address.cursorRect.pageIndex);
    return this.positionAtAddress(address, result.charOffset);
  }

  splitParagraph(position: TextPosition) {
    const result = this.splitAt(position);
    if (!result.ok) throw new Error("문단을 나누지 못했습니다.");
    this.undoStack.push({
      kind: "split",
      address: { ...position },
    });
    this.clearRedo();
    this.invalidatePages(position.cursorRect.pageIndex);
    return this.positionAtAddress(this.addressAtParagraph(position, result.paraIdx), result.charOffset);
  }

  insertPageBreak(position: TextPosition) {
    if (this.isCellPosition(position)) {
      throw new Error("쪽 나누기는 표 셀 안에 삽입할 수 없습니다.");
    }
    const beforeSnapshotId = this.document.saveSnapshot();
    try {
      const result = parseJson<{ ok: boolean; paraIdx: number; charOffset: number }>(
        this.document.insertPageBreak(position.sectionIndex, position.paragraphIndex, position.charOffset),
        "쪽 나누기",
      );
      if (!result.ok || !Number.isInteger(result.paraIdx) || !Number.isInteger(result.charOffset)) {
        throw new Error("쪽 나누기를 삽입하지 못했습니다.");
      }
      this.invalidatePages(position.cursorRect.pageIndex);
      const afterAddress = this.positionAt(position.sectionIndex, result.paraIdx, result.charOffset);
      const afterSnapshotId = this.document.saveSnapshot();
      this.undoStack.push({
        kind: "snapshot",
        beforeSnapshotId,
        afterSnapshotId,
        beforeAddress: { ...position },
        afterAddress: { ...afterAddress },
      });
      this.clearRedo();
      this.trimSnapshotHistory();
      return afterAddress;
    } catch (cause) {
      const restored = parseJson<{ ok: boolean }>(this.document.restoreSnapshot(beforeSnapshotId), "쪽 나누기 복구");
      if (!restored.ok) throw new Error("쪽 나누기 삽입에 실패했고 원본 문서 복구에도 실패했습니다.");
      this.invalidatePages(position.cursorRect.pageIndex);
      throw cause;
    }
  }

  undo() {
    const operation = this.undoStack.pop();
    if (!operation) return null;
    const position = this.applyInverse(operation);
    this.redoStack.push(operation);
    return position;
  }

  redo() {
    const operation = this.redoStack.pop();
    if (!operation) return null;
    const position = this.applyForward(operation);
    this.undoStack.push(operation);
    return position;
  }

  selectionRectangles(start: TextPosition, end: TextPosition): SelectionRectangle[] {
    if (!this.sameEditingScope(start, end) || this.comparePositions(start, end) === 0) return [];
    const [first, last] = this.orderedPositions(start, end);
    const json = this.isCellPosition(first)
      ? this.document.getSelectionRectsInCellByPathEx(JSON.stringify({
          sectionIdx: first.sectionIndex,
          parentParaIdx: first.parentParagraphIndex,
          path: JSON.stringify(first.cellPath),
          startCellParaIdx: first.paragraphIndex,
          startCharOffset: first.charOffset,
          endCellParaIdx: last.paragraphIndex,
          endCharOffset: last.charOffset,
          startPageHint: Math.min(first.cursorRect.pageIndex, last.cursorRect.pageIndex),
          endPageHint: Math.max(first.cursorRect.pageIndex, last.cursorRect.pageIndex),
        }))
      : this.document.getSelectionRects(
          first.sectionIndex,
          first.paragraphIndex,
          first.charOffset,
          last.paragraphIndex,
          last.charOffset,
        );
    return parseJson<SelectionRectangle[]>(json, "선택 영역 좌표");
  }

  characterProperties(position: TextPosition) {
    const json = this.isCellPosition(position)
      ? this.document.getCellCharPropertiesAtByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          position.charOffset,
        )
      : this.document.getCharPropertiesAt(
          position.sectionIndex,
          position.paragraphIndex,
          position.charOffset,
        );
    return parseJson<Record<string, unknown>>(json, "글자 속성");
  }

  clearTypingFormat() {
    this.typingFormat = {};
  }

  applyCharacterFormat(start: TextPosition, end: TextPosition, format: CharacterFormat) {
    this.typingFormat = { ...this.typingFormat, ...format };
    if (!this.sameEditingScope(start, end) || this.comparePositions(start, end) === 0) {
      return end;
    }
    const { last, segments } = this.rangeSegments(start, end);
    const operations: EditOperation[] = [];
    try {
      for (const segment of segments) {
        if (segment.start >= segment.end) continue;
        const before = this.getCharRuns(segment.address, segment.start, segment.end);
        try {
          this.applyCharacterFormatRaw(segment.address, segment.start, segment.end, this.toRhwpFormat(format));
          const after = this.getCharRuns(segment.address, segment.start, segment.end);
          operations.push({
            kind: "char-format",
            address: segment.address,
            start: segment.start,
            end: segment.end,
            before,
            after,
          });
        } catch (cause) {
          this.setCharRuns(segment.address, segment.start, segment.end, before);
          throw cause;
        }
      }
    } catch (cause) {
      for (const operation of [...operations].reverse()) {
        if (operation.kind === "char-format") {
          this.setCharRuns(operation.address, operation.start, operation.end, operation.before);
        }
      }
      throw cause;
    }
    if (!operations.length) return this.positionAtAddress(last, last.charOffset);
    this.undoStack.push(operations.length === 1 ? operations[0] : { kind: "compound", operations });
    this.clearRedo();
    this.invalidatePages(segments[0]?.address.cursorRect.pageIndex ?? 0);
    return this.positionAtAddress(last, last.charOffset);
  }

  applyParagraphAlignment(position: TextPosition, alignment: "left" | "center" | "right" | "justify") {
    return this.applyParagraphFormat(position, { alignment });
  }

  paragraphProperties(position: TextPosition) {
    if (this.isCellPosition(position)) {
      if (position.cellPath!.length !== 1) throw new Error("중첩 표 문단 속성은 아직 편집할 수 없습니다.");
      const cell = position.cellPath![0];
      return parseJson<Record<string, unknown>>(this.document.getCellParaPropertiesAt(
        position.sectionIndex,
        position.parentParagraphIndex!,
        cell.controlIndex,
        cell.cellIndex,
        position.paragraphIndex,
      ), "문단 속성");
    }
    return parseJson<Record<string, unknown>>(this.document.getParaPropertiesAt(
      position.sectionIndex,
      position.paragraphIndex,
    ), "문단 속성");
  }

  applyParagraphFormat(position: TextPosition, format: ParagraphFormat) {
    if (this.isCellPosition(position) && position.cellPath!.length !== 1) {
      throw new Error("중첩 표 문단 서식은 아직 편집할 수 없습니다.");
    }
    const allowed = new Set(["alignment", "lineSpacing", "lineSpacingType", "marginLeft", "marginRight", "indent", "spacingBefore", "spacingAfter"]);
    const entries = Object.entries(format);
    const alignments = new Set(["left", "center", "right", "justify"]);
    const spacingTypes = new Set(["Percent", "Fixed", "AtLeast"]);
    if (!entries.length || entries.some(([key, value]) => {
      if (!allowed.has(key)) return true;
      if (key === "alignment") return typeof value !== "string" || !alignments.has(value);
      if (key === "lineSpacingType") return typeof value !== "string" || !spacingTypes.has(value);
      return typeof value !== "number" || !Number.isFinite(value);
    })) {
      throw new Error("지원하지 않는 문단 서식 값입니다.");
    }
    if (typeof format.lineSpacing === "number" && (!Number.isFinite(format.lineSpacing) || format.lineSpacing < 10 || format.lineSpacing > 1000)) {
      throw new Error("줄 간격은 10%에서 1000% 사이로 지정하세요.");
    }
    return this.mutateWithSnapshot(position, "문단 서식", () => {
      const props = JSON.stringify(format);
      const raw = this.isCellPosition(position)
        ? this.document.applyParaFormatInCell(
            position.sectionIndex,
            position.parentParagraphIndex!,
            position.cellPath![0].controlIndex,
            position.cellPath![0].cellIndex,
            position.paragraphIndex,
            props,
          )
        : this.document.applyParaFormat(position.sectionIndex, position.paragraphIndex, props);
      if (!parseJson<{ ok: boolean }>(raw, "문단 서식").ok) throw new Error("문단 서식을 적용하지 못했습니다.");
    });
  }

  styleList() {
    return parseJson<DocumentStyle[]>(this.document.getStyleList(), "스타일 목록");
  }

  applyStyle(position: TextPosition, styleId: number) {
    if (!Number.isInteger(styleId) || styleId < 0) throw new Error("스타일을 선택하세요.");
    if (this.isCellPosition(position) && position.cellPath!.length !== 1) {
      throw new Error("중첩 표 스타일은 아직 적용할 수 없습니다.");
    }
    return this.mutateWithSnapshot(position, "스타일", () => {
      const raw = this.isCellPosition(position)
        ? this.document.applyCellStyle(
            position.sectionIndex,
            position.parentParagraphIndex!,
            position.cellPath![0].controlIndex,
            position.cellPath![0].cellIndex,
            position.paragraphIndex,
            styleId,
          )
        : this.document.applyStyle(position.sectionIndex, position.paragraphIndex, styleId);
      if (!parseJson<{ ok: boolean }>(raw, "스타일 적용").ok) throw new Error("스타일을 적용하지 못했습니다.");
    });
  }

  pageDefinition(sectionIndex: number) {
    const raw = parseJson<PageDefinition>(this.document.getPageDef(sectionIndex), "용지 설정");
    return {
      ...raw,
      width: rhwpUnitsToMillimeters(raw.width),
      height: rhwpUnitsToMillimeters(raw.height),
      marginLeft: rhwpUnitsToMillimeters(raw.marginLeft),
      marginRight: rhwpUnitsToMillimeters(raw.marginRight),
      marginTop: rhwpUnitsToMillimeters(raw.marginTop),
      marginBottom: rhwpUnitsToMillimeters(raw.marginBottom),
      marginHeader: rhwpUnitsToMillimeters(raw.marginHeader),
      marginFooter: rhwpUnitsToMillimeters(raw.marginFooter),
      marginGutter: rhwpUnitsToMillimeters(raw.marginGutter),
    };
  }

  setPageDefinition(position: TextPosition, updates: Partial<PageDefinition>) {
    const current = this.pageDefinition(position.sectionIndex);
    const next = { ...current, ...updates };
    const physicalFields = ["width", "height", "marginLeft", "marginRight", "marginTop", "marginBottom", "marginHeader", "marginFooter", "marginGutter"] as const;
    const numeric = physicalFields.map((field) => next[field]);
    if (numeric.some((value) => !Number.isFinite(value) || value < 0) || next.width < 10 || next.height < 10) {
      throw new Error("용지 크기와 여백 값을 확인하세요.");
    }
    if (next.marginLeft + next.marginRight >= next.width || next.marginTop + next.marginBottom >= next.height) {
      throw new Error("여백이 용지 크기보다 작아야 합니다.");
    }
    return this.mutateWithSnapshot(position, "용지 설정", () => {
      const toPageUnits = (value: number) => Math.round(value * RHWP_PAGE_UNITS_PER_MM);
      const documentDefinition = {
        ...next,
        width: toPageUnits(next.width),
        height: toPageUnits(next.height),
        marginLeft: toPageUnits(next.marginLeft),
        marginRight: toPageUnits(next.marginRight),
        marginTop: toPageUnits(next.marginTop),
        marginBottom: toPageUnits(next.marginBottom),
        marginHeader: toPageUnits(next.marginHeader),
        marginFooter: toPageUnits(next.marginFooter),
        marginGutter: toPageUnits(next.marginGutter),
      };
      const raw = this.document.setPageDef(position.sectionIndex, JSON.stringify(documentDefinition));
      if (!parseJson<{ ok: boolean }>(raw, "용지 설정").ok) throw new Error("용지 설정을 바꾸지 못했습니다.");
    }, 0);
  }

  insertHeaderFooterText(position: TextPosition, kind: HeaderFooterKind, text: string) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에서는 머리말이나 꼬리말을 추가할 수 없습니다.");
    if (!text.trim()) throw new Error("머리말이나 꼬리말 내용을 입력하세요.");
    if (/[\r\n]/.test(text)) throw new Error("현재 머리말·꼬리말 삽입은 한 문단의 텍스트만 지원합니다.");
    const target = this.headerFooterTarget(position, kind, "bothPages");
    const isHeader = kind === "header";
    const applyTo = target.applyTo;
    return this.mutateWithSnapshot(position, isHeader ? "머리말 삽입" : "꼬리말 삽입", () => {
      const current = parseJson<{ ok: boolean; exists: boolean }>(
        this.document.getHeaderFooter(target.sectionIndex, isHeader, applyTo),
        isHeader ? "머리말 조회" : "꼬리말 조회",
      );
      if (!current.ok) throw new Error("머리말·꼬리말 상태를 확인하지 못했습니다.");
      if (!current.exists) {
        const created = parseJson<{ ok: boolean }>(
          this.document.createHeaderFooter(target.sectionIndex, isHeader, applyTo),
          isHeader ? "머리말 생성" : "꼬리말 생성",
        );
        if (!created.ok) throw new Error("머리말·꼬리말을 만들지 못했습니다.");
      }
      const paragraph = parseJson<{ ok: boolean; paraCount: number; charCount: number }>(
        this.document.getHeaderFooterParaInfo(target.sectionIndex, isHeader, applyTo, 0),
        "머리말·꼬리말 문단 조회",
      );
      if (!paragraph.ok || paragraph.paraCount < 1 || !Number.isInteger(paragraph.charCount) || paragraph.charCount < 0) {
        throw new Error("머리말·꼬리말 문단을 편집할 수 없습니다.");
      }
      const inserted = parseJson<{ ok: boolean }>(
        this.document.insertTextInHeaderFooter(
          target.sectionIndex,
          isHeader,
          applyTo,
          0,
          paragraph.charCount,
          text,
        ),
        "머리말·꼬리말 삽입",
      );
      if (!inserted.ok) throw new Error("머리말·꼬리말 내용을 삽입하지 못했습니다.");
      return position.charOffset;
    }, 0);
  }

  headerFooterInfo(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에서는 머리말이나 꼬리말을 편집할 수 없습니다.");
    const target = this.headerFooterTarget(position, kind, scope);
    const isHeader = kind === "header";
    const headerFooter = parseJson<{ ok: boolean; exists: boolean }>(
      this.document.getHeaderFooter(target.sectionIndex, isHeader, target.applyTo),
      "머리말·꼬리말 조회",
    );
    if (!headerFooter.ok) throw new Error("머리말·꼬리말 상태를 확인하지 못했습니다.");
    if (!headerFooter.exists) {
      return { sectionIndex: target.sectionIndex, applyTo: target.applyTo, exists: false, text: "" };
    }
    const first = parseJson<{ ok: boolean; paraCount: number; charCount: number; text?: string }>(
      this.document.getHeaderFooterParaInfo(target.sectionIndex, isHeader, target.applyTo, 0),
      "머리말·꼬리말 문단 조회",
    );
    if (!first.ok || !Number.isInteger(first.paraCount) || first.paraCount < 1) {
      throw new Error("머리말·꼬리말 문단을 읽지 못했습니다.");
    }
    const paragraphs = [first.text ?? ""];
    for (let paragraphIndex = 1; paragraphIndex < first.paraCount; paragraphIndex += 1) {
      const info = parseJson<{ ok: boolean; text?: string }>(
        this.document.getHeaderFooterParaInfo(target.sectionIndex, isHeader, target.applyTo, paragraphIndex),
        "머리말·꼬리말 문단 조회",
      );
      if (!info.ok) throw new Error("머리말·꼬리말 문단을 읽지 못했습니다.");
      paragraphs.push(info.text ?? "");
    }
    return { sectionIndex: target.sectionIndex, applyTo: target.applyTo, exists: true, text: paragraphs.join("\n") };
  }

  setHeaderFooterText(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope, text: string) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에서는 머리말이나 꼬리말을 편집할 수 없습니다.");
    if (/[\r\n]/.test(text)) throw new Error("머리말·꼬리말은 한 문단씩 편집할 수 있습니다.");
    const info = this.headerFooterInfo(position, kind, scope);
    if (!text.length) return this.deleteHeaderFooter(position, kind, scope);
    const target = { sectionIndex: info.sectionIndex, applyTo: info.applyTo };
    const isHeader = kind === "header";
    return this.mutateWithSnapshot(position, isHeader ? "머리말 편집" : "꼬리말 편집", () => {
      if (!info.exists) {
        const created = parseJson<{ ok: boolean }>(
          this.document.createHeaderFooter(target.sectionIndex, isHeader, target.applyTo),
          "머리말·꼬리말 생성",
        );
        if (!created.ok) throw new Error("머리말·꼬리말을 만들지 못했습니다.");
      } else {
        const paragraph = parseJson<{ ok: boolean; paraCount: number; charCount: number; text?: string }>(
          this.document.getHeaderFooterParaInfo(target.sectionIndex, isHeader, target.applyTo, 0),
          "머리말·꼬리말 문단 조회",
        );
        if (!paragraph.ok || paragraph.paraCount !== 1 || !Number.isInteger(paragraph.charCount)) {
          throw new Error("여러 문단으로 된 머리말·꼬리말은 현재 통째로 바꾸지 않습니다. 기존 내용을 보존하려면 먼저 문서에서 해당 문단을 정리하세요.");
        }
        if ((paragraph.text ?? "").includes("\u0015") || (paragraph.text ?? "").includes("\u0016") || (paragraph.text ?? "").includes("\u0017")) {
          throw new Error("자동 필드가 들어 있는 머리말·꼬리말은 현재 평문 대화상자에서 덮어쓸 수 없습니다.");
        }
        const replaced = parseJson<{ ok: boolean }>(
          this.document.replaceRangeInHeaderFooter(
            target.sectionIndex, isHeader, target.applyTo, 0, 0, 0, paragraph.charCount, text,
          ),
          "머리말·꼬리말 바꾸기",
        );
        if (!replaced.ok) throw new Error("머리말·꼬리말을 바꾸지 못했습니다.");
      }
      if (!info.exists && text.length) {
        const inserted = parseJson<{ ok: boolean }>(
          this.document.insertTextInHeaderFooter(target.sectionIndex, isHeader, target.applyTo, 0, 0, text),
          "머리말·꼬리말 입력",
        );
        if (!inserted.ok) throw new Error("머리말·꼬리말 내용을 입력하지 못했습니다.");
      }
      return position.charOffset;
    }, 0);
  }

  deleteHeaderFooter(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에서는 머리말이나 꼬리말을 편집할 수 없습니다.");
    const info = this.headerFooterInfo(position, kind, scope);
    if (!info.exists) return position;
    const isHeader = kind === "header";
    return this.mutateWithSnapshot(position, isHeader ? "머리말 삭제" : "꼬리말 삭제", () => {
      const deleted = parseJson<{ ok: boolean }>(
        this.document.deleteHeaderFooter(info.sectionIndex, isHeader, info.applyTo),
        "머리말·꼬리말 삭제",
      );
      if (!deleted.ok) throw new Error("머리말·꼬리말을 삭제하지 못했습니다.");
      return position.charOffset;
    }, 0);
  }

  insertHeaderFooterField(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope, field: HeaderFooterFieldKind) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에서는 머리말이나 꼬리말을 편집할 수 없습니다.");
    const info = this.headerFooterInfo(position, kind, scope);
    const isHeader = kind === "header";
    const fieldType: Record<HeaderFooterFieldKind, number> = { pageNumber: 1, totalPages: 2, fileName: 3 };
    return this.mutateWithSnapshot(position, isHeader ? "머리말 필드" : "꼬리말 필드", () => {
      if (!info.exists) {
        const created = parseJson<{ ok: boolean }>(
          this.document.createHeaderFooter(info.sectionIndex, isHeader, info.applyTo),
          "머리말·꼬리말 생성",
        );
        if (!created.ok) throw new Error("머리말·꼬리말을 만들지 못했습니다.");
      }
      const paragraph = parseJson<{ ok: boolean; charCount: number }>(
        this.document.getHeaderFooterParaInfo(info.sectionIndex, isHeader, info.applyTo, 0),
        "머리말·꼬리말 문단 조회",
      );
      if (!paragraph.ok || !Number.isInteger(paragraph.charCount)) throw new Error("머리말·꼬리말 문단에 필드를 넣지 못했습니다.");
      const inserted = parseJson<{ ok: boolean }>(
        this.document.insertFieldInHf(info.sectionIndex, isHeader, info.applyTo, 0, paragraph.charCount, fieldType[field]),
        "머리말·꼬리말 필드 삽입",
      );
      if (!inserted.ok) throw new Error("머리말·꼬리말 필드를 넣지 못했습니다.");
      return position.charOffset;
    }, 0);
  }

  private headerFooterTarget(position: TextPosition, kind: HeaderFooterKind, scope: HeaderFooterScope) {
    if (scope === "currentPage") {
      const result = parseJson<{ ok: boolean; sectionIndex: number; applyTo: number }>(
        this.document.getHeaderFooterEditTarget(position.cursorRect.pageIndex, kind === "header"),
        "현재 쪽 머리말·꼬리말 대상",
      );
      if (!result.ok || !Number.isInteger(result.sectionIndex) || !Number.isInteger(result.applyTo)) {
        throw new Error("현재 쪽에 적용할 머리말·꼬리말 구역을 확인하지 못했습니다.");
      }
      return { sectionIndex: result.sectionIndex, applyTo: result.applyTo };
    }
    const applyTo = scope === "bothPages" ? 0 : scope === "evenPages" ? 1 : 2;
    return { sectionIndex: position.sectionIndex, applyTo };
  }

  insertPicture(position: TextPosition, imageData: Uint8Array, extension: string, naturalWidthPx: number, naturalHeightPx: number, widthMm: number, heightMm: number) {
    if (!imageData.byteLength || !Number.isInteger(naturalWidthPx) || !Number.isInteger(naturalHeightPx) || naturalWidthPx < 1 || naturalHeightPx < 1 || !Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm < 1 || heightMm < 1) {
      throw new Error("그림 데이터나 크기가 올바르지 않습니다.");
    }
    const width = Math.round(widthMm * RHWP_OBJECT_UNITS_PER_MM);
    const height = Math.round(heightMm * RHWP_OBJECT_UNITS_PER_MM);
    let logicalOffset = position.charOffset;
    return this.mutateWithSnapshot(position, "그림 삽입", () => {
      const raw = this.document.insertPictureEx(JSON.stringify({
        sectionIdx: position.sectionIndex,
        paraIdx: this.isCellPosition(position) ? position.parentParagraphIndex : position.paragraphIndex,
        charOffset: position.charOffset,
        cellPath: this.isCellPosition(position) ? JSON.stringify(position.cellPath) : "[]",
        width,
        height,
        naturalWidthPx,
        naturalHeightPx,
        extension,
        description: "",
      }), imageData);
      const result = parseJson<{ ok: boolean; logicalOffset?: number }>(raw, "그림 삽입");
      if (!result.ok) throw new Error("그림을 문서에 삽입하지 못했습니다.");
      if (Number.isInteger(result.logicalOffset)) logicalOffset = result.logicalOffset!;
      return logicalOffset;
    });
  }

  insertShape(position: TextPosition, kind: "rectangle" | "ellipse" | "textBox", widthMm: number, heightMm: number) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에는 도형을 삽입할 수 없습니다.");
    if (![widthMm, heightMm].every((value) => Number.isFinite(value) && value >= 1)) {
      throw new Error("도형 너비와 높이는 1mm 이상이어야 합니다.");
    }
    const width = Math.round(widthMm * RHWP_OBJECT_UNITS_PER_MM);
    const height = Math.round(heightMm * RHWP_OBJECT_UNITS_PER_MM);
    return this.mutateWithSnapshot(position, kind === "textBox" ? "글상자 삽입" : "사각형 삽입", () => {
      const raw = this.document.createShapeControl(JSON.stringify({
        sectionIdx: position.sectionIndex,
        paraIdx: position.paragraphIndex,
        charOffset: position.charOffset,
        width,
        height,
        horzOffset: Math.round(position.cursorRect.x * 75),
        vertOffset: Math.round(position.cursorRect.y * 75),
        treatAsChar: false,
        textWrap: "Square",
        shapeType: kind === "ellipse" ? "ellipse" : "rectangle",
      }));
      const created = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(raw, "도형 삽입");
      if (!created.ok || !Number.isInteger(created.paraIdx) || !Number.isInteger(created.controlIdx)) {
        throw new Error("도형을 문서에 삽입하지 못했습니다.");
      }
      if (kind === "textBox") {
        const attached = parseJson<{ ok: boolean }>(
          this.document.setTextBoxAt(created.paraIdx, created.controlIdx, true),
          "글상자 연결",
        );
        if (!attached.ok) throw new Error("도형에 편집 가능한 글상자를 연결하지 못했습니다.");
      }
      return position.charOffset;
    }, position.cursorRect.pageIndex, true);
  }

  listObjects(sectionIndex: number): DocumentObject[] {
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= this.document.getSectionCount()) {
      throw new RangeError("개체를 조회할 구역 번호가 올바르지 않습니다.");
    }
    const objects = parseJson<RawDocumentObject[]>(this.document.getObjects(), "문서 개체 목록");
    const cycles = parseJson<RawObjectCycle[]>(this.document.getObjectCycle(), "개체 쪽 위치");
    const layers = objectLayerIndex(this.document, cycles.map((cycle) => cycle.page));
    return objects.flatMap((item) => {
      if (!Number.isInteger(item.para) || !Number.isInteger(item.controlIndex) || (item.kind !== "picture" && item.kind !== "shape")) return [];
      const cycle = cycles.find((candidate) => candidate.para === item.para && candidate.controlIndex === item.controlIndex);
      const pageIndex = Number.isInteger(cycle?.page) ? cycle!.page : 0;
      const pageSection = this.pageInfo(Math.max(0, Math.min(pageIndex, this.pageCount - 1))).sectionIndex;
      if (pageSection !== sectionIndex) return [];
      const rawProperties = item.kind === "picture"
        ? this.document.getPictureProperties(sectionIndex, item.para, item.controlIndex)
        : this.document.getShapeProperties(sectionIndex, item.para, item.controlIndex);
      const props = parseJson<RawEditableObjectProperties>(rawProperties, "문서 개체 속성");
      if (!Number.isFinite(props.width) || !Number.isFinite(props.height)) return [];
      const layer = (layers.get(`${pageIndex}:${item.controlIndex}`) ?? []).find((entry) => (entry.op.type === "image") === (item.kind === "picture")
        && ["image", "rectangle", "ellipse"].includes(String(entry.op.type)));
      let bounds = {
        pageIndex,
        x: (Number.isFinite(props.horzOffset) ? props.horzOffset! : 0) / 75,
        y: (Number.isFinite(props.vertOffset) ? props.vertOffset! : 0) / 75,
        width: props.width! / 75,
        height: props.height! / 75,
      };
      if (layer) bounds = { pageIndex, ...layer.bounds };
      else if (item.kind === "shape") {
        try {
          const exact = parseJson<{ pageIndex: number; x: number; y: number; width: number; height: number }>(
            this.document.getShapeBBox(sectionIndex, item.para, item.controlIndex),
            "도형 위치",
          );
          if ([exact.pageIndex, exact.x, exact.y, exact.width, exact.height].every(Number.isFinite)) bounds = exact;
        } catch {
          // Shape properties still provide an editable, approximate page bound.
        }
      }
      const hasTextBox = item.kind === "shape" && this.document.getTextBoxControlIndex(sectionIndex, item.para) === item.controlIndex;
      const kind: DocumentObjectKind = item.kind === "picture" ? "picture" : hasTextBox ? "textBox" : layer?.op.type === "ellipse" ? "ellipse" : "rectangle";
      return [{
        id: `${sectionIndex}:${item.para}:${item.controlIndex}:${kind}`,
        kind,
        sectionIndex,
        paragraphIndex: item.para,
        controlIndex: item.controlIndex,
        pageIndex,
        bounds,
        zOrder: Number.isFinite(cycle?.z) ? cycle!.z! : 0,
        widthMm: rhwpUnitsToMillimeters(props.width!),
        heightMm: rhwpUnitsToMillimeters(props.height!),
        offsetXmm: rhwpUnitsToMillimeters(Number.isFinite(props.horzOffset) ? props.horzOffset! : 0),
        offsetYmm: rhwpUnitsToMillimeters(Number.isFinite(props.vertOffset) ? props.vertOffset! : 0),
        textWrap: objectTextWrap(props.textWrap),
        treatAsCharacter: props.treatAsChar ?? false,
        description: props.description ?? "",
      }];
    });
  }

  hitTestObject(pageIndex: number, x: number, y: number) {
    const sectionIndex = this.pageInfo(pageIndex).sectionIndex;
    const candidates = this.listObjects(sectionIndex)
      .filter((object) => object.pageIndex === pageIndex && x >= object.bounds.x && y >= object.bounds.y
        && x <= object.bounds.x + object.bounds.width && y <= object.bounds.y + object.bounds.height)
      .sort((left, right) => right.zOrder - left.zOrder);
    return candidates[0] ?? null;
  }

  updateObject(object: DocumentObject, updates: DocumentObjectUpdates) {
    const current = this.listObjects(object.sectionIndex).find((candidate) => candidate.id === object.id);
    if (!current) throw new Error("편집할 개체가 문서에 없습니다.");
    const next = { ...current, ...updates };
    if (![next.widthMm, next.heightMm].every((value) => Number.isFinite(value) && value >= 1)) {
      throw new Error("개체의 너비와 높이는 1mm 이상이어야 합니다.");
    }
    if (![next.offsetXmm, next.offsetYmm].every(Number.isFinite)) throw new Error("개체 위치 값을 확인하세요.");
    if (!OBJECT_TEXT_WRAPS.includes(next.textWrap)) throw new Error("지원하지 않는 글 배치 방식입니다.");
    const address = this.objectAddress(current);
    return this.mutateWithSnapshot(address, current.kind === "picture" ? "그림 속성" : "도형 속성", () => {
      const properties = {
        width: Math.round(next.widthMm * RHWP_OBJECT_UNITS_PER_MM),
        height: Math.round(next.heightMm * RHWP_OBJECT_UNITS_PER_MM),
        horzOffset: Math.round(next.offsetXmm * RHWP_OBJECT_UNITS_PER_MM),
        vertOffset: Math.round(next.offsetYmm * RHWP_OBJECT_UNITS_PER_MM),
        textWrap: next.textWrap,
        treatAsChar: next.treatAsCharacter,
        description: next.description,
      };
      const raw = current.kind === "picture"
        ? this.document.setPictureProperties(current.sectionIndex, current.paragraphIndex, current.controlIndex, JSON.stringify(properties))
        : this.document.setShapeProperties(current.sectionIndex, current.paragraphIndex, current.controlIndex, JSON.stringify(properties));
      if (!parseJson<{ ok: boolean }>(raw, "문서 개체 속성 변경").ok) throw new Error("개체 속성을 바꾸지 못했습니다.");
      return address.charOffset;
    }, current.pageIndex, true);
  }

  deleteObject(object: DocumentObject) {
    const current = this.listObjects(object.sectionIndex).find((candidate) => candidate.id === object.id);
    if (!current) throw new Error("삭제할 개체가 문서에 없습니다.");
    const address = this.objectAddress(current);
    return this.mutateWithSnapshot(address, current.kind === "picture" ? "그림 삭제" : "도형 삭제", () => {
      const raw = current.kind === "picture"
        ? this.document.deletePictureControl(current.sectionIndex, current.paragraphIndex, current.controlIndex)
        : this.document.deleteShapeControl(current.sectionIndex, current.paragraphIndex, current.controlIndex);
      if (!parseJson<{ ok: boolean }>(raw, "문서 개체 삭제").ok) throw new Error("개체를 삭제하지 못했습니다.");
      return address.charOffset;
    }, current.pageIndex, true);
  }

  setHyperlink(start: TextPosition, end: TextPosition, uri: string) {
    if (!this.sameEditingScope(start, end)) throw new Error("하이퍼링크는 한 문단 안의 선택 영역에만 적용할 수 있습니다.");
    const [first, last] = this.orderedPositions(start, end);
    if (first.sectionIndex !== last.sectionIndex || first.paragraphIndex !== last.paragraphIndex || first.charOffset === last.charOffset) {
      throw new Error("하이퍼링크를 적용할 한 문단의 글자를 선택하세요.");
    }
    if (!uri.trim()) throw new Error("웹 주소를 입력하세요.");
    const target = {
      section: first.sectionIndex,
      para: this.isCellPosition(first) ? first.parentParagraphIndex : first.paragraphIndex,
      cellPath: first.cellPath?.map((cell) => ({
        controlIndex: cell.controlIndex,
        cellIndex: cell.cellIndex,
        cellParaIndex: cell.cellParaIndex,
      })) ?? [],
    };
    return this.mutateWithSnapshot(first, "하이퍼링크", () => {
      const fieldId = this.document.insertHyperlinkEx(JSON.stringify({
        target,
        start: first.charOffset,
        end: last.charOffset,
        uri,
      }));
      if (fieldId < 1) throw new Error("하이퍼링크를 문서에 적용하지 못했습니다.");
    });
  }

  insertAutoNumber(position: TextPosition, kind: "page" | "current" | "total") {
    if (this.isCellPosition(position)) throw new Error("쪽 번호는 표 셀 안에 넣을 수 없습니다.");
    return this.mutateWithSnapshot(position, "자동 번호", () => {
      const raw = this.document.insertAutoNumberAtCursor(
        position.sectionIndex,
        position.paragraphIndex,
        position.charOffset,
        kind,
      );
      if (!parseJson<{ ok: boolean }>(raw, "자동 번호 삽입").ok) throw new Error("쪽 번호를 삽입하지 못했습니다.");
    });
  }

  insertFootnote(position: TextPosition, endnote = false) {
    if (this.isCellPosition(position)) throw new Error("각주와 미주는 표 셀 안에 넣을 수 없습니다.");
    return this.mutateWithSnapshot(position, endnote ? "미주" : "각주", () => {
      const raw = endnote
        ? this.document.insertEndnote(position.sectionIndex, position.paragraphIndex, position.charOffset)
        : this.document.insertFootnote(position.sectionIndex, position.paragraphIndex, position.charOffset);
      if (!parseJson<{ ok: boolean }>(raw, endnote ? "미주 삽입" : "각주 삽입").ok) {
        throw new Error(endnote ? "미주를 삽입하지 못했습니다." : "각주를 삽입하지 못했습니다.");
      }
    });
  }

  selectedText(start: TextPosition, end: TextPosition) {
    if (!this.sameEditingScope(start, end) || this.comparePositions(start, end) === 0) return "";
    const { first, last, segments } = this.rangeSegments(start, end);
    if (segments.length > 1) this.assertPlainTextRange(first, last);
    return segments.map(({ address, start: from, end: to }) => this.readTextRange(address, from, to)).join("\n");
  }

  deleteRange(start: TextPosition, end: TextPosition) {
    if (!this.sameEditingScope(start, end) || this.comparePositions(start, end) === 0) return end;
    const { first, last, segments } = this.rangeSegments(start, end);
    if (segments.length > 1) {
      this.assertPlainTextRange(first, last);
      return this.deleteMultiParagraphRange(first, last);
    }
    const address = segments[0].address;
    const text = this.readTextRange(address, segments[0].start, segments[0].end);
    if (Array.from(text).length !== last.charOffset - first.charOffset) {
      throw new Error("선택 범위에 문자가 아닌 개체가 포함되어 있어 이 범위는 아직 삭제할 수 없습니다.");
    }
    const charRuns = this.getCharRuns(address, segments[0].start, segments[0].end);
    const result = this.deleteTextRange(address, segments[0].start, segments[0].end);
    if (!result.ok) throw new Error("선택한 내용을 삭제하지 못했습니다.");
    this.undoStack.push({ kind: "delete", address, text, charRuns });
    this.clearRedo();
    this.invalidatePages(address.cursorRect.pageIndex);
    return this.positionAtAddress(address, result.charOffset);
  }

  replaceRange(start: TextPosition, end: TextPosition, text: string) {
    const historyStart = this.undoStack.length;
    let position = start;
    if (this.sameEditingScope(start, end) && this.comparePositions(start, end) !== 0) {
      position = this.deleteRange(start, end);
    }
    const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
    paragraphs.forEach((paragraph, index) => {
      if (paragraph) position = this.insertText(position, paragraph);
      if (index < paragraphs.length - 1) position = this.splitParagraph(position);
    });
    const operations = this.undoStack.splice(historyStart);
    if (operations.length === 1) this.undoStack.push(operations[0]);
    else if (operations.length > 1) this.undoStack.push({ kind: "compound", operations });
    if (operations.length) this.clearRedo();
    return position;
  }

  searchText(query: string, options?: SearchOptions | boolean): SearchMatch[] {
    const needle = query.trim();
    if (!needle) return [];
    const normalized = normalizeSearchOptions(options);
    const hits = parseJson<RawSearchHit[]>(
      this.document.searchAllText(needle, normalized.caseSensitive, normalized.includeCells),
      "문서 검색",
    );
    return hits.flatMap((hit) => {
      if (hit.equationControl !== undefined || hit.length < 1) return [];
      const cellPath = hit.cellPath?.map((segment) => ({ ...segment })) ?? (hit.cellContext
        ? [{
            controlIndex: hit.cellContext.ctrlIdx,
            cellIndex: hit.cellContext.cellIdx,
            cellParaIndex: hit.cellContext.cellPara,
          }]
        : undefined);
      const parentParagraphIndex = cellPath?.length ? hit.para : undefined;
      const paragraphIndex = cellPath?.length ? cellPath[cellPath.length - 1].cellParaIndex : hit.para;
      const start = this.positionAt(hit.sec, paragraphIndex, hit.charOffset, undefined, parentParagraphIndex, cellPath);
      const end = this.positionAt(hit.sec, paragraphIndex, hit.charOffset + hit.length, undefined, parentParagraphIndex, cellPath);
      return [{ start, end, matchedText: needle }];
    });
  }

  replaceAllText(query: string, replacement: string, options?: SearchOptions | boolean) {
    if (!query.trim()) throw new Error("찾을 내용을 입력하세요.");
    if (/[\r\n]/.test(replacement)) throw new Error("바꾸기 내용에는 문단 나눔을 넣을 수 없습니다.");
    const matches = this.searchText(query, options);
    if (!matches.length) return { count: 0, position: null };
    const historyStart = this.undoStack.length;
    let position: TextPosition | null = null;
    try {
      for (const match of [...matches].reverse()) {
        const properties = this.characterProperties(match.start);
        const previousTypingFormat = this.typingFormat;
        this.typingFormat = {
          ...(typeof properties.fontFamily === "string" ? { fontFamily: properties.fontFamily } : {}),
          ...(typeof properties.fontSize === "number" ? { fontSize: properties.fontSize } : {}),
          ...(typeof properties.bold === "boolean" ? { bold: properties.bold } : {}),
          ...(typeof properties.italic === "boolean" ? { italic: properties.italic } : {}),
          ...(typeof properties.underline === "boolean" ? { underline: properties.underline } : {}),
          ...(typeof properties.strikethrough === "boolean" ? { strikethrough: properties.strikethrough } : {}),
        };
        try {
          position = this.replaceRange(match.start, match.end, replacement);
        } finally {
          this.typingFormat = previousTypingFormat;
        }
      }
    } catch (cause) {
      const operations = this.undoStack.splice(historyStart);
      for (const operation of [...operations].reverse()) this.applyInverse(operation);
      throw cause;
    }
    const operations = this.undoStack.splice(historyStart);
    if (operations.length > 1) this.undoStack.push({ kind: "compound", operations });
    else if (operations.length === 1) this.undoStack.push(operations[0]);
    this.clearRedo();
    this.invalidatePages(Math.min(...matches.map((match) => match.start.cursorRect.pageIndex)));
    return { count: matches.length, position };
  }

  createTable(position: TextPosition, rows: number, columns: number) {
    if (this.isCellPosition(position)) throw new Error("표 안에 표를 추가하는 작업은 아직 지원하지 않습니다.");
    if (!Number.isInteger(rows) || rows < 1 || rows > 100 || !Number.isInteger(columns) || columns < 1 || columns > 100) {
      throw new Error("표의 행과 열은 1부터 100 사이의 정수여야 합니다.");
    }
    const result = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(
      this.document.createTable(position.sectionIndex, position.paragraphIndex, position.charOffset, rows, columns),
      "표 만들기",
    );
    if (!result.ok) throw new Error("표를 만들지 못했습니다.");
    const operation: EditOperation = {
      kind: "table",
      address: { ...position },
      rows,
      columns,
      tableParaIndex: result.paraIdx,
      controlIndex: result.controlIdx,
    };
    this.undoStack.push(operation);
    this.clearRedo();
    this.invalidatePages(position.cursorRect.pageIndex);
    return this.positionAt(
      position.sectionIndex,
      0,
      0,
      undefined,
      result.paraIdx,
      [{ controlIndex: result.controlIdx, cellIndex: 0, cellParaIndex: 0 }],
    );
  }

  moveTableCell(position: TextPosition, delta: -1 | 1) {
    if (!this.isCellPosition(position) || position.cellPath!.length !== 1) {
      throw new Error("현재 표 셀을 이동할 수 없습니다.");
    }
    const segment = position.cellPath![0];
    const dimensions = parseJson<{ cellCount: number }>(this.document.getTableDimensions(
      position.sectionIndex,
      position.parentParagraphIndex!,
      segment.controlIndex,
    ), "표 크기");
    const cellIndex = segment.cellIndex + delta;
    if (cellIndex < 0 || cellIndex >= dimensions.cellCount) return position;
    const nextPath = [{ ...segment, cellIndex, cellParaIndex: 0 }];
    return this.positionAt(position.sectionIndex, 0, 0, undefined, position.parentParagraphIndex, nextPath);
  }

  editTable(position: TextPosition, command: TableCommand) {
    if (!this.isCellPosition(position) || position.cellPath!.length !== 1) {
      throw new Error("표 편집은 중첩되지 않은 표의 셀에서 실행하세요.");
    }
    const segment = position.cellPath![0];
    const tableAddress = {
      section: position.sectionIndex,
      paragraph: position.parentParagraphIndex!,
      control: segment.controlIndex,
    };
    const dimensions = parseJson<{ rowCount: number; colCount: number; cellCount: number }>(
      this.document.getTableDimensions(tableAddress.section, tableAddress.paragraph, tableAddress.control),
      "표 크기",
    );
    const cell = parseJson<{ row: number; col: number; rowSpan: number; colSpan: number }>(
      this.document.getCellInfo(tableAddress.section, tableAddress.paragraph, tableAddress.control, segment.cellIndex),
      "현재 셀 위치",
    );
    if (command === "deleteRow" && dimensions.rowCount <= 1) throw new Error("마지막 행은 삭제할 수 없습니다.");
    if (command === "deleteColumn" && dimensions.colCount <= 1) throw new Error("마지막 열은 삭제할 수 없습니다.");
    if (command === "mergeRight" && (cell.rowSpan !== 1 || cell.colSpan !== 1 || cell.col + 1 >= dimensions.colCount)) {
      throw new Error("오른쪽 인접 셀과 병합할 수 있는 일반 셀을 선택하세요.");
    }
    if (command === "mergeDown" && (cell.rowSpan !== 1 || cell.colSpan !== 1 || cell.row + 1 >= dimensions.rowCount)) {
      throw new Error("아래쪽 인접 셀과 병합할 수 있는 일반 셀을 선택하세요.");
    }

    const beforeSnapshotId = this.document.saveSnapshot();
    let targetRow = cell.row;
    let targetCol = cell.col;
    try {
      let raw: string;
      switch (command) {
        case "insertRowAbove":
        case "insertRowBelow": {
          const anchorRow = command === "insertRowBelow" ? cell.row + cell.rowSpan - 1 : cell.row;
          raw = this.document.insertTableRow(tableAddress.section, tableAddress.paragraph, tableAddress.control, anchorRow, command === "insertRowBelow");
          if (command === "insertRowAbove") targetRow++;
          break;
        }
        case "insertColumnLeft":
        case "insertColumnRight": {
          const anchorColumn = command === "insertColumnRight" ? cell.col + cell.colSpan - 1 : cell.col;
          raw = this.document.insertTableColumn(tableAddress.section, tableAddress.paragraph, tableAddress.control, anchorColumn, command === "insertColumnRight");
          if (command === "insertColumnLeft") targetCol++;
          break;
        }
        case "deleteRow":
          raw = this.document.deleteTableRow(tableAddress.section, tableAddress.paragraph, tableAddress.control, cell.row);
          if (cell.row === dimensions.rowCount - 1) targetRow = Math.max(0, cell.row - 1);
          break;
        case "deleteColumn":
          raw = this.document.deleteTableColumn(tableAddress.section, tableAddress.paragraph, tableAddress.control, cell.col);
          if (cell.col === dimensions.colCount - 1) targetCol = Math.max(0, cell.col - 1);
          break;
        case "mergeRight":
          raw = this.document.mergeTableCells(tableAddress.section, tableAddress.paragraph, tableAddress.control, cell.row, cell.col, cell.row, cell.col + 1);
          break;
        case "mergeDown":
          raw = this.document.mergeTableCells(tableAddress.section, tableAddress.paragraph, tableAddress.control, cell.row, cell.col, cell.row + 1, cell.col);
          break;
        case "splitCell":
          raw = this.document.splitTableCell(tableAddress.section, tableAddress.paragraph, tableAddress.control, cell.row, cell.col);
          break;
      }
      if (!parseJson<{ ok: boolean }>(raw!, "표 편집").ok) throw new Error("표 편집을 적용하지 못했습니다.");
      const updatedDimensions = parseJson<{ rowCount: number; colCount: number; cellCount: number }>(
        this.document.getTableDimensions(tableAddress.section, tableAddress.paragraph, tableAddress.control),
        "변경된 표 크기",
      );
      targetRow = Math.max(0, Math.min(targetRow, updatedDimensions.rowCount - 1));
      targetCol = Math.max(0, Math.min(targetCol, updatedDimensions.colCount - 1));
      const cellIndex = this.cellIndexAt(tableAddress, updatedDimensions.cellCount, targetRow, targetCol);
      const afterAddress = this.positionAt(
        position.sectionIndex,
        0,
        0,
        undefined,
        position.parentParagraphIndex,
        [{ controlIndex: segment.controlIndex, cellIndex, cellParaIndex: 0 }],
      );
      const afterSnapshotId = this.document.saveSnapshot();
      this.clearRedo();
      this.undoStack.push({
        kind: "snapshot",
        beforeSnapshotId,
        afterSnapshotId,
        beforeAddress: { ...position },
        afterAddress,
      });
      this.trimSnapshotHistory();
      this.invalidatePages(position.cursorRect.pageIndex);
      return afterAddress;
    } catch (cause) {
      this.document.restoreSnapshot(beforeSnapshotId);
      this.document.discardSnapshot(beforeSnapshotId);
      this.invalidatePages(position.cursorRect.pageIndex);
      throw cause;
    }
  }

  tableLayout(position: TextPosition): TableLayoutInfo {
    if (!this.isCellPosition(position) || position.cellPath!.length !== 1) throw new Error("표 셀을 선택하세요.");
    const segment = position.cellPath![0]; const para = position.parentParagraphIndex!;
    const table = parseJson<Record<string, unknown>>(this.document.getTableProperties(position.sectionIndex, para, segment.controlIndex), "표 배치 속성");
    const cellInfo = parseJson<{ col: number; rowSpan: number; colSpan: number }>(this.document.getCellInfo(position.sectionIndex, para, segment.controlIndex, segment.cellIndex), "셀 위치");
    const cell = parseJson<Record<string, unknown>>(this.document.getCellOwnProperties(position.sectionIndex, para, segment.controlIndex, segment.cellIndex), "셀 크기");
    return {
      widthMm: rhwpUnitsToMillimeters(Number(table.tableWidth ?? cell.width ?? 0)),
      offsetXmm: rhwpUnitsToMillimeters(Number(table.horzOffset ?? 0)),
      offsetYmm: rhwpUnitsToMillimeters(Number(table.vertOffset ?? 0)),
      horizontalAlignment: table.horzAlign === "Center" || table.horzAlign === "Right" ? table.horzAlign : "Left",
      columnWidthMm: rhwpUnitsToMillimeters(Number(cell.width ?? 0)) / Math.max(1, cellInfo.colSpan),
      rowHeightMm: rhwpUnitsToMillimeters(Number(cell.height ?? 0)) / Math.max(1, cellInfo.rowSpan),
      cellPaddingMm: rhwpUnitsToMillimeters(Number(cell.paddingLeft ?? 0)),
      cellFillColor: cell.fillType === "solid" && typeof cell.fillColor === "string" ? cell.fillColor : null,
      cellBorderColor: typeof (cell.borderLeft as Record<string, unknown> | undefined)?.color === "string"
        ? (cell.borderLeft as Record<string, unknown>).color as string : "#000000",
    };
  }

  updateTable(position: TextPosition, updates: TableUpdates) {
    if (!this.isCellPosition(position) || position.cellPath!.length !== 1) throw new Error("표 셀을 선택하세요.");
    const segment = position.cellPath![0]; const para = position.parentParagraphIndex!; const control = segment.controlIndex;
    const cellInfo = parseJson<{ row: number; col: number; rowSpan: number; colSpan: number }>(
      this.document.getCellInfo(position.sectionIndex, para, control, segment.cellIndex), "셀 위치",
    );
    const dimensions = parseJson<{ rowCount: number; colCount: number; cellCount: number }>(
      this.document.getTableDimensions(position.sectionIndex, para, control), "표 크기",
    );
    if (updates.columnWidthMm !== undefined && cellInfo.colSpan !== 1) throw new Error("병합 셀에서는 열 너비를 바꿀 수 없습니다.");
    const numeric = [updates.widthMm, updates.offsetXmm, updates.offsetYmm, updates.columnWidthMm, updates.rowHeightMm, updates.cellPaddingMm]
      .filter((value): value is number => value !== undefined);
    if (numeric.some((value) => !Number.isFinite(value)) || (updates.widthMm !== undefined && updates.widthMm < 10)
      || (updates.columnWidthMm !== undefined && updates.columnWidthMm < 5) || (updates.rowHeightMm !== undefined && updates.rowHeightMm < 2)
      || (updates.cellPaddingMm !== undefined && (updates.cellPaddingMm < 0 || updates.cellPaddingMm > 30))) {
      throw new Error("표 크기, 위치 및 셀 여백 값을 확인하세요.");
    }
    for (const color of [updates.cellFillColor, updates.borderColor]) {
      if (color !== undefined && color !== null && !/^#[0-9a-f]{6}$/iu.test(color)) throw new Error("셀 색상은 6자리 HEX 색상으로 지정하세요.");
    }
    return this.mutateWithSnapshot(position, "표 크기 및 셀 서식", () => {
      const tableProperties = parseJson<Record<string, unknown>>(this.document.getTableProperties(position.sectionIndex, para, control), "표 속성");
      let oldWidth = Number(tableProperties.tableWidth ?? 0);
      if (updates.columnWidthMm !== undefined) {
        if (oldWidth <= 0) throw new Error("현재 표 너비를 확인하지 못했습니다.");
        const widthEquations: Array<{ col: number; span: number; widthMm: number }> = [];
        for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
          const info = parseJson<{ col: number; colSpan: number }>(this.document.getCellInfo(position.sectionIndex, para, control, cellIndex), "셀 위치");
          const properties = parseJson<Record<string, unknown>>(this.document.getCellOwnProperties(position.sectionIndex, para, control, cellIndex), "셀 너비");
          if (typeof properties.width !== "number") throw new Error("표의 열 너비를 확인하지 못했습니다.");
          widthEquations.push({ col: info.col, span: info.colSpan, widthMm: rhwpUnitsToMillimeters(properties.width) });
        }
        const currentColumns = solveTableColumnWidths(dimensions.colCount, widthEquations, rhwpUnitsToMillimeters(oldWidth));
        const selectedColumn = cellInfo.col;
        const nextColumn = Math.round(updates.columnWidthMm * RHWP_PAGE_UNITS_PER_MM);
        const targetWidth = updates.widthMm === undefined
          ? oldWidth + nextColumn - Math.round(currentColumns[selectedColumn] * RHWP_PAGE_UNITS_PER_MM)
          : Math.round(updates.widthMm * RHWP_PAGE_UNITS_PER_MM);
        const otherColumns = dimensions.colCount - 1;
        const remainingWidth = targetWidth - nextColumn;
        if (remainingWidth < otherColumns * 5 * RHWP_PAGE_UNITS_PER_MM
          || (otherColumns === 0 && Math.abs(remainingWidth) > 0.75 * RHWP_PAGE_UNITS_PER_MM)) {
          throw new Error("표 전체 너비와 선택한 열 너비가 맞지 않습니다.");
        }

        const currentOtherWidth = currentColumns.reduce((sum, width, index) => sum + (index === selectedColumn ? 0 : width), 0);
        const nextColumns = Array(dimensions.colCount).fill(0) as number[];
        nextColumns[selectedColumn] = nextColumn;
        let assigned = nextColumn;
        const remainingIndices = [...Array(dimensions.colCount).keys()].filter((index) => index !== selectedColumn);
        remainingIndices.forEach((index, remainingIndex) => {
          const units = remainingIndex === remainingIndices.length - 1
            ? targetWidth - assigned
            : Math.round(remainingWidth * (currentOtherWidth > 0 ? currentColumns[index] / currentOtherWidth : 1 / otherColumns));
          nextColumns[index] = units;
          assigned += units;
        });

        for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
          const info = parseJson<{ col: number; colSpan: number }>(this.document.getCellInfo(position.sectionIndex, para, control, cellIndex), "셀 위치");
          const properties = parseJson<Record<string, unknown>>(this.document.getCellOwnProperties(position.sectionIndex, para, control, cellIndex), "셀 크기");
          properties.width = nextColumns.slice(info.col, info.col + info.colSpan).reduce((sum, width) => sum + width, 0);
          if (!parseJson<{ ok: boolean }>(this.document.setCellProperties(position.sectionIndex, para, control, cellIndex, JSON.stringify(properties)), "열 너비").ok) {
            throw new Error("열 너비를 바꾸지 못했습니다.");
          }
        }
        tableProperties.tableWidth = targetWidth;
        oldWidth = targetWidth;
      } else if (updates.widthMm !== undefined) {
        if (oldWidth <= 0) throw new Error("현재 표 너비를 확인하지 못했습니다.");
        const newWidth = Math.round(updates.widthMm * RHWP_PAGE_UNITS_PER_MM);
        const ratio = newWidth / oldWidth;
        tableProperties.tableWidth = newWidth; oldWidth = newWidth;
        for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
          const cellProperties = parseJson<Record<string, unknown>>(this.document.getCellOwnProperties(position.sectionIndex, para, control, cellIndex), "셀 크기");
          if (typeof cellProperties.width === "number") {
            cellProperties.width = Math.round(cellProperties.width * ratio);
            if (!parseJson<{ ok: boolean }>(this.document.setCellProperties(position.sectionIndex, para, control, cellIndex, JSON.stringify(cellProperties)), "열 너비").ok) throw new Error("열 너비를 바꾸지 못했습니다.");
          }
        }
      }
      if (updates.offsetXmm !== undefined) tableProperties.horzOffset = Math.round(updates.offsetXmm * RHWP_PAGE_UNITS_PER_MM);
      if (updates.offsetYmm !== undefined) tableProperties.vertOffset = Math.round(updates.offsetYmm * RHWP_PAGE_UNITS_PER_MM);
      if (updates.horizontalAlignment) tableProperties.horzAlign = updates.horizontalAlignment;
      if (!parseJson<{ ok: boolean }>(this.document.setTableProperties(position.sectionIndex, para, control, JSON.stringify(tableProperties)), "표 배치").ok) throw new Error("표 배치를 바꾸지 못했습니다.");

      const selectedProperties = parseJson<Record<string, unknown>>(this.document.getCellOwnProperties(position.sectionIndex, para, control, segment.cellIndex), "셀 속성");
      if (updates.rowHeightMm !== undefined) selectedProperties.height = Math.round(updates.rowHeightMm * Math.max(1, cellInfo.rowSpan) * RHWP_PAGE_UNITS_PER_MM);
      if (updates.cellPaddingMm !== undefined) {
        const raw = Math.round(updates.cellPaddingMm * RHWP_PAGE_UNITS_PER_MM);
        selectedProperties.paddingLeft = raw; selectedProperties.paddingRight = raw; selectedProperties.paddingTop = raw; selectedProperties.paddingBottom = raw;
      }
      if (updates.cellFillColor !== undefined) {
        selectedProperties.fillType = updates.cellFillColor ? "solid" : "none";
        selectedProperties.fillColor = updates.cellFillColor ?? "#ffffff";
      }
      if (updates.borderColor !== undefined) {
        for (const side of ["borderLeft", "borderRight", "borderTop", "borderBottom"]) {
          const border = selectedProperties[side];
          selectedProperties[side] = { ...(typeof border === "object" && border !== null ? border as Record<string, unknown> : {}), color: updates.borderColor };
        }
      }
      if (updates.rowHeightMm !== undefined || updates.cellPaddingMm !== undefined || updates.cellFillColor !== undefined || updates.borderColor !== undefined) {
        if (!parseJson<{ ok: boolean }>(this.document.setCellProperties(position.sectionIndex, para, control, segment.cellIndex, JSON.stringify(selectedProperties)), "셀 속성").ok) throw new Error("셀 서식을 바꾸지 못했습니다.");
      }
    });
  }

  exportWithReport(format?: "hwp" | "hwpx"): ExportResult {
    const outputFormat = format ?? this.sourceFormat;
    if (outputFormat !== "hwp" && outputFormat !== "hwpx") {
      throw new Error("현재 저장할 수 없는 문서 형식입니다.");
    }
    let result: DocumentExport;
    if (outputFormat === "hwp") {
      result = this.document.exportHwpWithReport();
    } else {
      result = this.document.exportHwpxWithReport();
    }

    try {
      const report = parseJson<ContentLossReport>(result.contentLoss(), "내용 손실 보고서");
      if (
        !Number.isInteger(report.schemaVersion) ||
        report.schemaVersion < 1 ||
        report.outputFormat !== outputFormat ||
        !Number.isInteger(report.count) ||
        report.count < 0 ||
        !Array.isArray(report.losses) ||
        report.count !== report.losses.length
      ) {
        throw new Error("내용 손실 보고서가 올바르지 않아 저장을 중단했습니다.");
      }
      const bytes = result.takeBytes();
      const headerFieldLosses = this.checkHeaderFooterFieldRoundTrip(bytes, outputFormat);
      const losses = [...report.losses, ...headerFieldLosses];
      return { bytes, report: { ...report, count: losses.length, losses } };
    } finally {
      result.free();
    }
  }

  private checkHeaderFooterFieldRoundTrip(bytes: Uint8Array, outputFormat: "hwp" | "hwpx") {
    const fields: Array<{ sectionIndex: number; isHeader: boolean; applyTo: number; paragraphIndex: number; marker: string }> = [];
    const inspectionFailures: Array<{ sectionIndex: number; isHeader: boolean; applyTo: number; paragraphIndex?: number }> = [];
    for (let sectionIndex = 0; sectionIndex < this.document.getSectionCount(); sectionIndex += 1) {
      for (const isHeader of [true, false]) {
        for (const applyTo of [0, 1, 2]) {
          const exists = parseJson<{ ok: boolean; exists: boolean }>(
            this.document.getHeaderFooter(sectionIndex, isHeader, applyTo),
            "머리말·꼬리말 저장 검증",
          );
          if (!exists.ok) {
            inspectionFailures.push({ sectionIndex, isHeader, applyTo });
            continue;
          }
          if (!exists.exists) continue;
          const first = parseJson<{ ok: boolean; paraCount: number; text?: string }>(
            this.document.getHeaderFooterParaInfo(sectionIndex, isHeader, applyTo, 0),
            "머리말·꼬리말 필드 저장 검증",
          );
          if (!first.ok || !Number.isInteger(first.paraCount) || first.paraCount < 1) {
            inspectionFailures.push({ sectionIndex, isHeader, applyTo, paragraphIndex: 0 });
            continue;
          }
          for (let paragraphIndex = 0; paragraphIndex < first.paraCount; paragraphIndex += 1) {
            const paragraph = paragraphIndex === 0 ? first : parseJson<{ ok: boolean; text?: string }>(
              this.document.getHeaderFooterParaInfo(sectionIndex, isHeader, applyTo, paragraphIndex),
              "머리말·꼬리말 필드 저장 검증",
            );
            if (!paragraph.ok) {
              inspectionFailures.push({ sectionIndex, isHeader, applyTo, paragraphIndex });
              continue;
            }
            for (const marker of ["\u0015", "\u0016", "\u0017"]) {
              if ((paragraph.text ?? "").includes(marker)) fields.push({ sectionIndex, isHeader, applyTo, paragraphIndex, marker });
            }
          }
        }
      }
    }
    const location = (item: { sectionIndex: number; isHeader: boolean; applyTo: number; paragraphIndex?: number }) =>
      `${item.sectionIndex + 1}구역 ${item.applyTo === 0 ? "양쪽" : item.applyTo === 1 ? "짝수 쪽" : "홀수 쪽"} ${item.isHeader ? "머리말" : "꼬리말"}`
      + (item.paragraphIndex === undefined ? "" : ` ${item.paragraphIndex + 1}번째 문단`);
    const unknownLosses = inspectionFailures.map((item) => ({
      code: "header-footer-field-unverified",
      subject: `${item.isHeader ? "머리말" : "꼬리말"} 자동 필드 보존 여부`,
      reason: `${outputFormat.toUpperCase()} 저장 전에 머리말·꼬리말 구조를 검사하지 못했습니다.`,
      message: `${location(item)} 내용을 확인하지 못해 자동 필드 보존 여부를 보장할 수 없습니다.`,
    }));
    if (!fields.length) return unknownLosses;

    let reopened: HwpDocument | undefined;
    try {
      reopened = new HwpDocument(bytes);
      return [...unknownLosses, ...fields.flatMap((field) => {
        const headerFooter = parseJson<{ ok: boolean; exists: boolean }>(
          reopened!.getHeaderFooter(field.sectionIndex, field.isHeader, field.applyTo),
          "머리말·꼬리말 재열기 검증",
        );
        const paragraph = headerFooter.ok && headerFooter.exists ? parseJson<{ ok: boolean; text?: string }>(
          reopened!.getHeaderFooterParaInfo(field.sectionIndex, field.isHeader, field.applyTo, field.paragraphIndex),
          "머리말·꼬리말 재열기 검증",
        ) : { ok: false, text: "" };
        const preserved = paragraph.ok && (paragraph.text ?? "").includes(field.marker);
        if (preserved) return [];
        const markerName = field.marker === "\u0015" ? "쪽 번호" : field.marker === "\u0016" ? "전체 쪽 수" : "파일 이름";
        return [{
          code: "header-footer-field-roundtrip",
          subject: `${field.isHeader ? "머리말" : "꼬리말"} ${markerName}`,
          reason: `현재 RHWP 직렬화는 머리말·꼬리말의 U+${field.marker.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()} 필드 마커를 같은 필드 레코드로 복원하지 않습니다.`,
          message: `${location(field)}의 ${markerName} 필드가 ${outputFormat.toUpperCase()} 재열기 후 보존되지 않았습니다. 저장을 계속하면 이 필드 구조가 손실됩니다.`,
        }];
      })];
    } catch {
      return [...unknownLosses, ...fields.map((field) => ({
        code: "header-footer-field-roundtrip-unverified",
        subject: `${field.isHeader ? "머리말" : "꼬리말"} 자동 필드`,
        reason: `${outputFormat.toUpperCase()} 재열기 검증을 수행하지 못했습니다.`,
        message: `${location(field)}의 자동 필드가 저장 후 보존되는지 확인하지 못했습니다.`,
      }))];
    } finally {
      reopened?.free();
    }
  }

  dispose() {
    this.renderedPages.clear();
    this.undoStack.length = 0;
    this.clearRedo();
    this.document.free();
  }

  private mutateWithSnapshot(
    address: TextPosition,
    label: string,
    mutate: () => number | void,
    invalidateFromPage = address.cursorRect.pageIndex,
    retainAddress = false,
  ) {
    const beforeSnapshotId = this.document.saveSnapshot();
    let afterSnapshotId: number | undefined;
    try {
      const nextOffset = mutate();
      this.invalidatePages(invalidateFromPage);
      const afterAddress = retainAddress
        ? { ...address }
        : this.positionAtAddress(address, typeof nextOffset === "number" ? nextOffset : address.charOffset);
      afterSnapshotId = this.document.saveSnapshot();
      this.undoStack.push({
        kind: "snapshot",
        beforeSnapshotId,
        afterSnapshotId,
        beforeAddress: { ...address },
        afterAddress: { ...afterAddress },
        ...(retainAddress ? { preserveCursorRect: true } : {}),
      });
      this.clearRedo();
      this.trimSnapshotHistory();
      return afterAddress;
    } catch (cause) {
      const restored = parseJson<{ ok: boolean }>(this.document.restoreSnapshot(beforeSnapshotId), `${label} 복구`);
      this.document.discardSnapshot(beforeSnapshotId);
      if (afterSnapshotId !== undefined) this.document.discardSnapshot(afterSnapshotId);
      this.invalidatePages(invalidateFromPage);
      if (!restored.ok) throw new Error(`${label}에 실패했고 원본 문서 복구에도 실패했습니다.`);
      throw cause;
    }
  }

  private applyInsert(position: TextPosition, text: string, format: Record<string, unknown> = {}) {
    const result = parseJson<{ ok: boolean; charOffset: number }>(
      this.isCellPosition(position)
        ? this.document.insertTextInCellByPath(
            position.sectionIndex,
            position.parentParagraphIndex!,
            JSON.stringify(position.cellPath),
            position.charOffset,
            text,
          )
        : this.document.insertText(
            position.sectionIndex,
            position.paragraphIndex,
            position.charOffset,
            text,
          ),
      "문자 삽입",
    );
    if (!result.ok) throw new Error("문자를 삽입하지 못했습니다.");
    const nextOffset = result.charOffset;
    if (Object.keys(format).length) {
      this.applyCharacterFormatRaw(position, position.charOffset, nextOffset, format);
    }
    this.invalidatePages(position.cursorRect.pageIndex);
    return this.positionAtAddress(position, nextOffset);
  }

  private applyInverse(operation: EditOperation): TextPosition {
    switch (operation.kind) {
      case "insert": {
        const length = Array.from(operation.text).length;
        const result = this.deleteTextRange(operation.address, operation.address.charOffset, operation.address.charOffset + length);
        if (!result.ok) throw new Error("입력 내용을 되돌리지 못했습니다.");
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, result.charOffset);
      }
      case "delete": {
        const position = this.applyInsert(operation.address, operation.text);
        if (operation.charRuns) this.setCharRuns(operation.address, operation.address.charOffset, operation.address.charOffset + Array.from(operation.text).length, operation.charRuns);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return position;
      }
      case "split": {
        const nextParagraph = this.addressAtParagraph(operation.address, operation.address.paragraphIndex + 1);
        const result = this.mergeAt(nextParagraph);
        if (!result.ok) throw new Error("문단 나누기를 되돌리지 못했습니다.");
        operation.removedParaMeta = result.removedParaMeta === undefined ? undefined : JSON.stringify(result.removedParaMeta);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, result.charOffset);
      }
      case "merge": {
        const previous = this.addressAtParagraph(operation.address, operation.address.paragraphIndex - 1);
        const result = this.splitAt(previous, operation.charOffset, operation.removedParaMeta);
        if (!result.ok) throw new Error("문단 병합을 되돌리지 못했습니다.");
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return operation.caretAfterUndo === "start"
          ? this.positionAtAddress(this.addressAtParagraph(previous, result.paraIdx), 0)
          : this.positionAtAddress(previous, operation.charOffset);
      }
      case "char-format":
        this.setCharRuns(operation.address, operation.start, operation.end, operation.before);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, operation.end);
      case "para-align":
        this.applyAlignmentRaw(operation.address, operation.before);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, operation.address.charOffset);
      case "table": {
        const result = parseJson<{ ok: boolean }>(this.document.deleteTableControl(
          operation.address.sectionIndex,
          operation.tableParaIndex,
          operation.controlIndex,
        ), "표 실행 취소");
        if (!result.ok) throw new Error("표 삽입을 되돌리지 못했습니다.");
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, operation.address.charOffset);
      }
      case "snapshot": {
        const result = parseJson<{ ok: boolean }>(this.document.restoreSnapshot(operation.beforeSnapshotId), "문서 실행 취소");
        if (!result.ok) throw new Error("표 편집을 되돌리지 못했습니다.");
        this.invalidatePages(0);
        return operation.preserveCursorRect ? { ...operation.beforeAddress } : this.positionAtAddress(operation.beforeAddress, operation.beforeAddress.charOffset);
      }
      case "compound": {
        let position: TextPosition | null = null;
        for (const child of [...operation.operations].reverse()) position = this.applyInverse(child);
        return position ?? this.positionAt(0, 0, 0);
      }
    }
  }

  private applyForward(operation: EditOperation): TextPosition {
    switch (operation.kind) {
      case "insert": return this.applyInsert(operation.address, operation.text, operation.format);
      case "delete": {
        const result = this.deleteTextRange(operation.address, operation.address.charOffset, operation.address.charOffset + Array.from(operation.text).length);
        if (!result.ok) throw new Error("삭제를 다시 실행하지 못했습니다.");
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, result.charOffset);
      }
      case "split": {
        const result = this.splitAt(operation.address, operation.address.charOffset, operation.removedParaMeta);
        if (!result.ok) throw new Error("문단 나누기를 다시 실행하지 못했습니다.");
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(this.addressAtParagraph(operation.address, result.paraIdx), result.charOffset);
      }
      case "merge": {
        const result = this.mergeAt(operation.address);
        if (!result.ok) throw new Error("문단 병합을 다시 실행하지 못했습니다.");
        operation.removedParaMeta = result.removedParaMeta === undefined ? undefined : JSON.stringify(result.removedParaMeta);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(this.addressAtParagraph(operation.address, result.paraIdx), result.charOffset);
      }
      case "char-format":
        this.setCharRuns(operation.address, operation.start, operation.end, operation.after);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, operation.end);
      case "para-align":
        this.applyAlignmentRaw(operation.address, operation.after);
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAtAddress(operation.address, operation.address.charOffset);
      case "table": {
        const result = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(this.document.createTable(
          operation.address.sectionIndex,
          operation.address.paragraphIndex,
          operation.address.charOffset,
          operation.rows,
          operation.columns,
        ), "표 다시 삽입");
        if (!result.ok) throw new Error("표를 다시 만들지 못했습니다.");
        operation.tableParaIndex = result.paraIdx;
        operation.controlIndex = result.controlIdx;
        this.invalidatePages(operation.address.cursorRect.pageIndex);
        return this.positionAt(
          operation.address.sectionIndex,
          0,
          0,
          undefined,
          result.paraIdx,
          [{ controlIndex: result.controlIdx, cellIndex: 0, cellParaIndex: 0 }],
        );
      }
      case "snapshot": {
        const result = parseJson<{ ok: boolean }>(this.document.restoreSnapshot(operation.afterSnapshotId), "문서 다시 실행");
        if (!result.ok) throw new Error("표 편집을 다시 실행하지 못했습니다.");
        this.invalidatePages(0);
        return operation.preserveCursorRect ? { ...operation.afterAddress } : this.positionAtAddress(operation.afterAddress, operation.afterAddress.charOffset);
      }
      case "compound": {
        let position: TextPosition | null = null;
        for (const child of operation.operations) position = this.applyForward(child);
        return position ?? this.positionAt(0, 0, 0);
      }
    }
  }

  private mergeParagraph(position: TextPosition, caretAfterUndo: "start" | "merge") {
    const result = this.mergeAt(position);
    if (!result.ok) throw new Error("문단을 병합하지 못했습니다.");
    this.undoStack.push({
      kind: "merge",
      address: { ...position },
      charOffset: result.charOffset,
      caretAfterUndo,
      removedParaMeta: result.removedParaMeta === undefined ? undefined : JSON.stringify(result.removedParaMeta),
    });
    this.clearRedo();
    this.invalidatePages(position.cursorRect.pageIndex);
    return this.positionAtAddress(this.addressAtParagraph(position, result.paraIdx), result.charOffset);
  }

  private mergeAt(position: TextPosition) {
    const raw = this.isCellPosition(position)
      ? this.document.mergeParagraphInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
        )
      : this.document.mergeParagraph(position.sectionIndex, position.paragraphIndex);
    const result = parseJson<{ ok: boolean; paraIdx?: number; cellParaIndex?: number; charOffset: number; removedParaMeta?: unknown }>(raw, "문단 병합");
    if (result.paraIdx === undefined && result.cellParaIndex !== undefined) result.paraIdx = result.cellParaIndex;
    if (result.paraIdx === undefined) throw new Error("병합된 문단 번호를 확인하지 못했습니다.");
    return result as typeof result & { paraIdx: number };
  }

  private splitAt(position: TextPosition, charOffset = position.charOffset, removedParaMeta?: string) {
    const raw = this.isCellPosition(position)
      ? this.document.splitParagraphInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          charOffset,
          removedParaMeta,
        )
      : this.document.splitParagraph(position.sectionIndex, position.paragraphIndex, charOffset, removedParaMeta);
    const result = parseJson<{ ok: boolean; paraIdx?: number; cellParaIndex?: number; charOffset: number; removedParaMeta?: unknown }>(raw, "문단 나누기");
    if (result.paraIdx === undefined && result.cellParaIndex !== undefined) result.paraIdx = result.cellParaIndex;
    if (result.paraIdx === undefined) throw new Error("문단 번호를 확인하지 못했습니다.");
    return result as typeof result & { paraIdx: number };
  }

  private deleteTextRange(position: TextPosition, start: number, end: number) {
    const raw = this.isCellPosition(position)
      ? this.document.deleteRangeInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          position.paragraphIndex,
          start,
          position.paragraphIndex,
          end,
        )
      : this.document.deleteRange(position.sectionIndex, position.paragraphIndex, start, position.paragraphIndex, end);
    return parseJson<{ ok: boolean; paraIdx?: number; charOffset: number }>(raw, "문자 삭제");
  }

  private readTextRange(position: TextPosition, start: number, end: number) {
    return this.isCellPosition(position)
      ? this.document.getTextInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          start,
          end - start,
        )
      : this.document.getTextRange(position.sectionIndex, position.paragraphIndex, start, end - start);
  }

  private getCharRuns(position: TextPosition, start: number, end: number) {
    return this.isCellPosition(position)
      ? this.document.getCharShapeRunsInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          start,
          end,
        )
      : this.document.getCharShapeRuns(position.sectionIndex, position.paragraphIndex, start, end);
  }

  private setCharRuns(position: TextPosition, start: number, end: number, runs: string) {
    const raw = this.isCellPosition(position)
      ? this.document.setCharShapeRunsInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          start,
          end,
          runs,
        )
      : this.document.setCharShapeRuns(position.sectionIndex, position.paragraphIndex, start, end, runs);
    if (!parseJson<{ ok: boolean }>(raw, "글자 서식 복원").ok) throw new Error("글자 서식을 복원하지 못했습니다.");
  }

  private applyCharacterFormatRaw(position: TextPosition, start: number, end: number, format: Record<string, unknown>) {
    const props = JSON.stringify(format);
    const raw = this.isCellPosition(position)
      ? this.document.applyCharFormatInCellByPath(
          position.sectionIndex,
          position.parentParagraphIndex!,
          JSON.stringify(position.cellPath),
          start,
          end,
          props,
        )
      : this.document.applyCharFormat(position.sectionIndex, position.paragraphIndex, start, end, props);
    if (!parseJson<{ ok: boolean }>(raw, "글자 서식").ok) throw new Error("글자 서식을 적용하지 못했습니다.");
  }

  private applyAlignmentRaw(position: TextPosition, alignment: string) {
    if (this.isCellPosition(position)) {
      const segment = position.cellPath![0];
      const raw = this.document.applyParaFormatInCell(
        position.sectionIndex,
        position.parentParagraphIndex!,
        segment.controlIndex,
        segment.cellIndex,
        position.paragraphIndex,
        JSON.stringify({ alignment }),
      );
      if (!parseJson<{ ok: boolean }>(raw, "문단 정렬 복원").ok) throw new Error("문단 정렬을 복원하지 못했습니다.");
    } else {
      const raw = this.document.applyParaFormat(position.sectionIndex, position.paragraphIndex, JSON.stringify({ alignment }));
      if (!parseJson<{ ok: boolean }>(raw, "문단 정렬 복원").ok) throw new Error("문단 정렬을 복원하지 못했습니다.");
    }
  }

  private toRhwpFormat(format: CharacterFormat): Record<string, unknown> {
    const result: Record<string, unknown> = { ...format };
    delete result.fontFamily;
    if (format.fontFamily) {
      result.fontIds = Array.from({ length: 7 }, (_, language) =>
        this.document.findOrCreateFontIdForLang(language, format.fontFamily!),
      );
    }
    return result;
  }

  private isCellPosition(position: TextPosition): boolean {
    return Boolean(position.cellPath?.length && position.parentParagraphIndex !== undefined);
  }

  private cellIndexAt(
    tableAddress: { section: number; paragraph: number; control: number },
    cellCount: number,
    row: number,
    column: number,
  ) {
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const cell = parseJson<{ row: number; col: number; rowSpan: number; colSpan: number }>(
        this.document.getCellInfo(tableAddress.section, tableAddress.paragraph, tableAddress.control, cellIndex),
        "셀 인덱스",
      );
      if (row >= cell.row && row < cell.row + cell.rowSpan && column >= cell.col && column < cell.col + cell.colSpan) {
        return cellIndex;
      }
    }
    throw new Error("편집 후 표에서 현재 셀을 찾지 못했습니다.");
  }

  private discardOperationSnapshots(operation: EditOperation) {
    if (operation.kind === "snapshot") {
      this.document.discardSnapshot(operation.beforeSnapshotId);
      this.document.discardSnapshot(operation.afterSnapshotId);
    } else if (operation.kind === "compound") {
      for (const child of operation.operations) this.discardOperationSnapshots(child);
    }
  }

  private clearRedo() {
    for (const operation of this.redoStack) this.discardOperationSnapshots(operation);
    this.redoStack.length = 0;
  }

  private trimSnapshotHistory() {
    const snapshotCount = () => [...this.undoStack, ...this.redoStack].reduce((total, operation) =>
      total + (operation.kind === "snapshot" ? 1 : operation.kind === "compound"
        ? operation.operations.filter((child) => child.kind === "snapshot").length
        : 0), 0);
    while (snapshotCount() > 45 && this.undoStack.length) {
      this.discardOperationSnapshots(this.undoStack.shift()!);
    }
  }

  private objectAddress(object: DocumentObject): TextPosition {
    try {
      return this.positionAt(object.sectionIndex, object.paragraphIndex, 0);
    } catch {
      // RHWP may place an anchored object in an otherwise empty paragraph with no caret stop.
      // Keep a stable, page-local anchor so snapshot undo/redo can still return to the object.
      return {
        sectionIndex: object.sectionIndex,
        paragraphIndex: object.paragraphIndex,
        charOffset: 0,
        cursorRect: {
          pageIndex: object.pageIndex,
          x: object.bounds.x,
          y: object.bounds.y,
          height: 14,
        },
      };
    }
  }

  private paragraphLength(position: TextPosition) {
    return this.isCellPosition(position)
      ? this.document.getCellParagraphLengthByPath(position.sectionIndex, position.parentParagraphIndex!, JSON.stringify(position.cellPath))
      : this.document.getParagraphLength(position.sectionIndex, position.paragraphIndex);
  }

  private paragraphCount(position: TextPosition) {
    return this.isCellPosition(position)
      ? this.document.getCellParagraphCountByPath(position.sectionIndex, position.parentParagraphIndex!, JSON.stringify(position.cellPath))
      : this.document.getParagraphCount(position.sectionIndex);
  }

  private sameEditingScope(left: TextPosition, right: TextPosition) {
    const leftPath = left.cellPath ?? [];
    const rightPath = right.cellPath ?? [];
    return left.sectionIndex === right.sectionIndex
      && left.parentParagraphIndex === right.parentParagraphIndex
      && leftPath.length === rightPath.length
      && leftPath.every((segment, index) => {
        const other = rightPath[index];
        return other?.controlIndex === segment.controlIndex && other.cellIndex === segment.cellIndex;
      });
  }

  private comparePositions(left: TextPosition, right: TextPosition) {
    return left.paragraphIndex - right.paragraphIndex || left.charOffset - right.charOffset;
  }

  private orderedPositions(left: TextPosition, right: TextPosition): [TextPosition, TextPosition] {
    return this.comparePositions(left, right) <= 0 ? [left, right] : [right, left];
  }

  private rangeSegments(start: TextPosition, end: TextPosition) {
    const [first, last] = this.orderedPositions(start, end);
    const segments = [] as Array<{ address: TextPosition; start: number; end: number }>;
    for (let paragraphIndex = first.paragraphIndex; paragraphIndex <= last.paragraphIndex; paragraphIndex++) {
      const address = this.addressAtParagraph(first, paragraphIndex);
      segments.push({
        address,
        start: paragraphIndex === first.paragraphIndex ? first.charOffset : 0,
        end: paragraphIndex === last.paragraphIndex ? last.charOffset : this.paragraphLength(address),
      });
    }
    return { first, last, segments };
  }

  private assertPlainTextRange(start: TextPosition, end: TextPosition) {
    const controls = parseJson<Array<{ ctrlId?: string; para?: number; controlIndex?: number }>>(
      this.document.getControls(),
      "선택 범위 개체",
    );
    const cell = this.isCellPosition(start);
    const firstParagraph = cell ? start.parentParagraphIndex! : start.paragraphIndex;
    const lastParagraph = cell ? end.parentParagraphIndex! : end.paragraphIndex;
    const selectedControl = cell ? start.cellPath![0] : undefined;
    const unsupported = controls.some((control) => {
      if (typeof control.para !== "number" || control.para < firstParagraph || control.para > lastParagraph) return false;
      if (control.ctrlId === "secd" || control.ctrlId === "cold") return false;
      if (
        selectedControl
        && control.para === start.parentParagraphIndex
        && control.ctrlId === "tbl"
        && control.controlIndex === selectedControl.controlIndex
      ) return false;
      return true;
    });
    if (unsupported) {
      throw new Error("선택 범위에 표, 그림 또는 다른 개체가 포함되어 있어 텍스트 범위만 복사하거나 삭제할 수 없습니다.");
    }
  }

  private deleteMultiParagraphRange(first: TextPosition, last: TextPosition) {
    const beforeSnapshotId = this.document.saveSnapshot();
    try {
      const raw = this.isCellPosition(first)
        ? this.document.deleteRangeInCellByPath(
            first.sectionIndex,
            first.parentParagraphIndex!,
            JSON.stringify(first.cellPath),
            first.paragraphIndex,
            first.charOffset,
            last.paragraphIndex,
            last.charOffset,
          )
        : this.document.deleteRange(
            first.sectionIndex,
            first.paragraphIndex,
            first.charOffset,
            last.paragraphIndex,
            last.charOffset,
          );
      const result = parseJson<{ ok: boolean; paraIdx?: number; cellParaIndex?: number; charOffset: number }>(raw, "여러 문단 선택 삭제");
      if (!result.ok) throw new Error("여러 문단의 선택 범위를 삭제하지 못했습니다.");
      const paragraphIndex = result.cellParaIndex ?? result.paraIdx ?? first.paragraphIndex;
      const address = this.addressAtParagraph(first, paragraphIndex);
      const position = this.positionAtAddress(address, result.charOffset);
      const afterSnapshotId = this.document.saveSnapshot();
      this.undoStack.push({
        kind: "snapshot",
        beforeSnapshotId,
        afterSnapshotId,
        beforeAddress: { ...first },
        afterAddress: { ...position },
      });
      this.clearRedo();
      this.trimSnapshotHistory();
      this.invalidatePages(first.cursorRect.pageIndex);
      return position;
    } catch (cause) {
      const restored = parseJson<{ ok: boolean }>(this.document.restoreSnapshot(beforeSnapshotId), "선택 범위 삭제 복구");
      if (!restored.ok) throw new Error("선택 범위 삭제 중 오류가 발생했고 원본 문서 복구에도 실패했습니다.");
      throw cause;
    }
  }

  private addressAtParagraph(position: TextPosition, paragraphIndex: number): TextPosition {
    if (this.isCellPosition(position)) {
      const cellPath = position.cellPath!.map((segment) => ({ ...segment }));
      cellPath[cellPath.length - 1].cellParaIndex = paragraphIndex;
      return { ...position, paragraphIndex, cellPath };
    }
    return { ...position, paragraphIndex };
  }

  private positionAtAddress(position: TextPosition, charOffset: number): TextPosition {
    return this.positionAt(
      position.sectionIndex,
      position.paragraphIndex,
      charOffset,
      undefined,
      position.parentParagraphIndex,
      position.cellPath,
    );
  }

  private positionAt(
    sectionIndex: number,
    paragraphIndex: number,
    charOffset: number,
    knownRect?: CursorRectangle,
    parentParagraphIndex?: number,
    cellPath?: CellPathSegment[],
  ): TextPosition {
    const cursorRect = knownRect ?? parseJson<CursorRectangle>(
      cellPath?.length && parentParagraphIndex !== undefined
        ? this.document.getCursorRectByPath(sectionIndex, parentParagraphIndex, JSON.stringify(cellPath), charOffset)
        : this.document.getCursorRect(sectionIndex, paragraphIndex, charOffset),
      "커서 위치",
    );
    return {
      sectionIndex,
      paragraphIndex,
      charOffset,
      cursorRect,
      ...(parentParagraphIndex === undefined ? {} : { parentParagraphIndex }),
      ...(cellPath?.length ? { cellPath: cellPath.map((segment) => ({ ...segment })) } : {}),
    };
  }

  private invalidatePages(fromPageIndex = 0) {
    const firstStalePage = Math.max(0, fromPageIndex);
    for (const pageIndex of this.renderedPages.keys()) {
      if (pageIndex >= firstStalePage) this.renderedPages.delete(pageIndex);
    }
  }
}

export async function loadHwpDocument(bytes: Uint8Array): Promise<DocumentSession> {
  const waitingStartedAt = now();
  await initializeEngine();
  const initializationWaitMs = now() - waitingStartedAt;

  const parseStartedAt = now();
  const document = new HwpDocument(bytes);
  const parseAndLayoutMs = now() - parseStartedAt;
  const sessionStartedAt = now();
  const session = new RhwpDocumentSession(document);
  reportEnginePerformance({
    phase: "open",
    bytes: bytes.byteLength,
    format: session.sourceFormat,
    wasmInitializationRuns: initializationRuns,
    wasmInitializationMs: Number(initializationDurationMs.toFixed(1)),
    wasmWaitMs: Number(initializationWaitMs.toFixed(1)),
    rhwpParseModelAndInitialLayoutMs: Number(parseAndLayoutMs.toFixed(1)),
    sessionSetupMs: Number((now() - sessionStartedAt).toFixed(1)),
    pageCount: session.pageCount,
  });
  return session;
}

export async function createNewHwpDocumentSession(): Promise<DocumentSession> {
  await initializeEngine();
  return createInitializedBlankHwpDocumentSession();
}

/** Create a fresh RHWP-backed blank document after WASM initialization has completed. */
export function createInitializedBlankHwpDocumentSession(): DocumentSession {
  if (!initialization) throw new Error("RHWP WASM 엔진이 초기화되지 않았습니다.");
  const document = HwpDocument.createEmpty();
  try {
    const created = parseJson<{ version?: string; sectionCount?: number }>(
      document.createBlankDocument(),
      "새 문서 생성",
    );
    if (
      !created.version ||
      typeof created.sectionCount !== "number" ||
      !Number.isInteger(created.sectionCount) ||
      created.sectionCount < 1
    ) {
      throw new Error("새 HWP 문서를 만들지 못했습니다.");
    }
  } catch (cause) {
    document.free();
    throw cause;
  }
  return new RhwpDocumentSession(document);
}

/** Batch serializer used only for text-engine documents created by Hanul. */
function findRhwpCellIndex(document: HwpDocument, tableParagraphIndex: number, controlIndex: number, cellCount: number, row: number, col: number): number {
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const cell = parseJson<{ row: number; col: number }>(document.getCellInfo(0, tableParagraphIndex, controlIndex, cellIndex), "표 셀 위치");
    if (cell.row === row && cell.col === col) return cellIndex;
  }
  throw new Error(`표의 ${row + 1}행 ${col + 1}열 셀을 다시 찾지 못했습니다.`);
}

export function serializePlainTextWithRhwp(
  paragraphs: readonly PlainTextParagraph[],
  format: "hwp" | "hwpx",
  pageDefinition: PageDefinition,
): ExportResult {
  if (!initialization) throw new Error("RHWP WASM 엔진이 초기화되지 않았습니다.");
  const document = HwpDocument.createEmpty();
  try {
    const created = parseJson<{ version?: string; sectionCount?: number }>(document.createBlankDocument(), "새 HWP 문서 생성");
    if (!created.version || !created.sectionCount) throw new Error("새 문서 직렬화 기반을 만들지 못했습니다.");
    const rawPageDefinition = {
      ...pageDefinition,
      width: Math.round(pageDefinition.width * RHWP_PAGE_UNITS_PER_MM),
      height: Math.round(pageDefinition.height * RHWP_PAGE_UNITS_PER_MM),
      marginLeft: Math.round(pageDefinition.marginLeft * RHWP_PAGE_UNITS_PER_MM),
      marginRight: Math.round(pageDefinition.marginRight * RHWP_PAGE_UNITS_PER_MM),
      marginTop: Math.round(pageDefinition.marginTop * RHWP_PAGE_UNITS_PER_MM),
      marginBottom: Math.round(pageDefinition.marginBottom * RHWP_PAGE_UNITS_PER_MM),
      marginHeader: Math.round(pageDefinition.marginHeader * RHWP_PAGE_UNITS_PER_MM),
      marginFooter: Math.round(pageDefinition.marginFooter * RHWP_PAGE_UNITS_PER_MM),
      marginGutter: Math.round(pageDefinition.marginGutter * RHWP_PAGE_UNITS_PER_MM),
    };
    if (!parseJson<{ ok: boolean }>(document.setPageDef(0, JSON.stringify(rawPageDefinition)), "용지 설정 저장").ok) {
      throw new Error("문서의 용지 설정을 저장하지 못했습니다.");
    }
    document.beginBatch();
    const targetParagraphs: number[] = [];
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      let targetParagraphIndex = index;
      if (index > 0) {
        const previous = paragraphs[index - 1];
        const previousParagraphIndex = targetParagraphs[index - 1];
        const splitResult = paragraph.pageBreakBefore
          ? parseJson<{ ok: boolean; paraIdx?: number }>(document.insertPageBreak(0, previousParagraphIndex, previous.text.length), "쪽 나누기")
          : parseJson<{ ok: boolean; paraIdx?: number }>(document.splitParagraph(0, previousParagraphIndex, previous.text.length), "문단 분리");
        if (!splitResult.ok || splitResult.paraIdx === undefined) throw new Error(`${index + 1}번째 문단을 만들지 못했습니다.`);
        targetParagraphIndex = splitResult.paraIdx;
      } else if (paragraph.pageBreakBefore) {
        const pageBreak = parseJson<{ ok: boolean; paraIdx?: number }>(document.insertPageBreak(0, 0, 0), "첫 쪽 나누기");
        if (!pageBreak.ok || pageBreak.paraIdx === undefined) throw new Error("첫 문단의 쪽 나누기를 저장하지 못했습니다.");
        targetParagraphIndex = pageBreak.paraIdx;
      }
      targetParagraphs[index] = targetParagraphIndex;
      if (paragraph.table) {
        if (paragraph.objects?.length) throw new Error("표 앵커와 개체가 함께 있는 문서는 개체 순서를 안전하게 저장할 수 없습니다.");
        const table = paragraph.table;
        const createdTable = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(
          document.createTable(0, targetParagraphIndex, 0, table.rowCount, table.colCount),
          "표 삽입",
        );
        if (!createdTable.ok) throw new Error(`${index + 1}번째 표를 저장하지 못했습니다.`);
        targetParagraphs[index] = createdTable.paraIdx;
        if (Object.keys(table.properties).length) {
          const appliedTable = parseJson<{ ok: boolean }>(document.setTableProperties(0, createdTable.paraIdx, createdTable.controlIdx, JSON.stringify(table.properties)), "표 속성");
          if (!appliedTable.ok) throw new Error(`${index + 1}번째 표 속성을 저장하지 못했습니다.`);
        }
        for (const cell of table.cells) {
          if (cell.rowSpan <= 1 && cell.colSpan <= 1) continue;
          const merged = parseJson<{ ok: boolean }>(document.mergeTableCells(
            0, createdTable.paraIdx, createdTable.controlIdx,
            cell.row, cell.col, cell.row + cell.rowSpan - 1, cell.col + cell.colSpan - 1,
          ), "셀 병합");
          if (!merged.ok) throw new Error(`${index + 1}번째 표의 병합 셀을 저장하지 못했습니다.`);
        }
        const cellCount = parseJson<{ cellCount: number }>(document.getTableDimensions(0, createdTable.paraIdx, createdTable.controlIdx), "표 셀 수").cellCount;
        for (const cell of table.cells) {
          const targetCellIndex = findRhwpCellIndex(document, createdTable.paraIdx, createdTable.controlIdx, cellCount, cell.row, cell.col);
          if (Object.keys(cell.properties).length || cell.rowSpan > 1 || cell.colSpan > 1) {
            const cellProperties = {
              ...cell.properties,
              width: Math.round(cell.widthMm * RHWP_PAGE_UNITS_PER_MM),
              height: Math.round(cell.heightMm * RHWP_PAGE_UNITS_PER_MM),
            };
            const appliedCell = parseJson<{ ok: boolean }>(document.setCellProperties(0, createdTable.paraIdx, createdTable.controlIdx, targetCellIndex, JSON.stringify(cellProperties)), "셀 속성");
            if (!appliedCell.ok) throw new Error(`${index + 1}번째 표의 셀 속성을 저장하지 못했습니다.`);
          }
          for (let cellParaIndex = 0; cellParaIndex < cell.paragraphs.length; cellParaIndex += 1) {
            const cellParagraph = cell.paragraphs[cellParaIndex];
            if (cellParaIndex > 0) {
              const previousCellParagraph = cell.paragraphs[cellParaIndex - 1];
              const split = parseJson<{ ok: boolean }>(document.splitParagraphInCell(
                0, createdTable.paraIdx, createdTable.controlIdx, targetCellIndex, cellParaIndex - 1, previousCellParagraph.text.length,
              ), "셀 문단 분리");
              if (!split.ok) throw new Error(`${index + 1}번째 표 셀 문단을 저장하지 못했습니다.`);
            }
            if (cellParagraph.text) {
              const inserted = parseJson<{ ok: boolean }>(document.insertTextInCell(
                0, createdTable.paraIdx, createdTable.controlIdx, targetCellIndex, cellParaIndex, 0, cellParagraph.text,
              ), "셀 텍스트");
              if (!inserted.ok) throw new Error(`${index + 1}번째 표 셀 내용을 저장하지 못했습니다.`);
            }
            if (Object.keys(cellParagraph.paragraphFormat).length) {
              const applied = parseJson<{ ok: boolean }>(document.applyParaFormatInCell(
                0, createdTable.paraIdx, createdTable.controlIdx, targetCellIndex, cellParaIndex, JSON.stringify(cellParagraph.paragraphFormat),
              ), "셀 문단 서식");
              if (!applied.ok) throw new Error(`${index + 1}번째 표 셀 문단 서식을 저장하지 못했습니다.`);
            }
            for (const run of cellParagraph.characterFormats) {
              if (run.end <= run.start) continue;
              const formatValue: Record<string, unknown> = { ...run.format };
              const family = typeof formatValue.fontFamily === "string" ? formatValue.fontFamily : "";
              delete formatValue.fontFamily;
              if (family) formatValue.fontIds = Array.from({ length: 7 }, (_, language) => document.findOrCreateFontIdForLang(language, family));
              const applied = parseJson<{ ok: boolean }>(document.applyCharFormatInCell(
                0, createdTable.paraIdx, createdTable.controlIdx, targetCellIndex, cellParaIndex, run.start, run.end, JSON.stringify(formatValue),
              ), "셀 글자 서식");
              if (!applied.ok) throw new Error(`${index + 1}번째 표 셀 글자 서식을 저장하지 못했습니다.`);
            }
          }
        }
        continue;
      }
      if (paragraph.text) {
        const inserted = parseJson<{ ok: boolean }>(document.insertText(0, targetParagraphIndex, 0, paragraph.text), "문단 입력");
        if (!inserted.ok) throw new Error(`${index + 1}번째 문단 텍스트를 저장하지 못했습니다.`);
      }
      if (Object.keys(paragraph.paragraphFormat).length) {
        const format = { ...paragraph.paragraphFormat };
        for (const key of ["marginLeft", "marginRight", "indent"] as const) {
          if (typeof format[key] === "number") format[key] = Math.round(format[key]! * 150);
        }
        const applied = parseJson<{ ok: boolean }>(document.applyParaFormat(0, targetParagraphIndex, JSON.stringify(format)), "문단 서식");
        if (!applied.ok) throw new Error(`${index + 1}번째 문단 서식을 저장하지 못했습니다.`);
      }
      for (const run of paragraph.characterFormats) {
        if (run.end <= run.start) continue;
        const formatValue: Record<string, unknown> = { ...run.format };
        const family = typeof formatValue.fontFamily === "string" ? formatValue.fontFamily : "";
        delete formatValue.fontFamily;
        if (family) formatValue.fontIds = Array.from({ length: 7 }, (_, language) => document.findOrCreateFontIdForLang(language, family));
        const applied = parseJson<{ ok: boolean }>(document.applyCharFormat(0, targetParagraphIndex, run.start, run.end, JSON.stringify(formatValue)), "글자 서식");
        if (!applied.ok) throw new Error(`${index + 1}번째 문단의 글자 서식을 저장하지 못했습니다.`);
      }
      for (const object of [...(paragraph.objects ?? [])].sort((left, right) => left.zOrder - right.zOrder)) {
        serializePlainTextObject(document, targetParagraphIndex, object);
      }
    }
    document.endBatch();
    const exported = format === "hwp" ? document.exportHwpWithReport() : document.exportHwpxWithReport();
    try {
      const report = parseJson<ContentLossReport>(exported.contentLoss(), "내용 손실 보고서");
      if (
        !Number.isInteger(report.schemaVersion) ||
        report.schemaVersion < 1 ||
        report.outputFormat !== format ||
        !Number.isInteger(report.count) ||
        report.count < 0 ||
        !Array.isArray(report.losses) ||
        report.count !== report.losses.length
      ) {
        throw new Error("내용 손실 보고서가 올바르지 않아 저장을 중단했습니다.");
      }
      return { bytes: exported.takeBytes(), report };
    } finally {
      exported.free();
    }
  } finally {
    document.free();
  }
}

function serializePlainTextObject(document: HwpDocument, paraIndex: number, object: PlainTextObject): void {
  const width = Math.round(object.widthMm * RHWP_OBJECT_UNITS_PER_MM);
  const height = Math.round(object.heightMm * RHWP_OBJECT_UNITS_PER_MM);
  const horzOffset = Math.round(object.offsetXmm * RHWP_OBJECT_UNITS_PER_MM);
  const vertOffset = Math.round(object.offsetYmm * RHWP_OBJECT_UNITS_PER_MM);
  if (object.kind === "picture") {
    if (!object.imageData?.length || !object.imageExtension || !object.naturalWidthPx || !object.naturalHeightPx) {
      throw new Error("그림 원본 데이터와 크기가 없어 저장할 수 없습니다.");
    }
    const raw = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(document.insertPictureEx(JSON.stringify({
      sectionIdx: 0, paraIdx: paraIndex, charOffset: object.anchorCharOffset,
      width, height, naturalWidthPx: object.naturalWidthPx, naturalHeightPx: object.naturalHeightPx,
      extension: object.imageExtension, description: object.description,
      paperOffsetXHu: horzOffset, paperOffsetYHu: vertOffset,
    }), object.imageData), "그림 저장");
    if (!raw.ok || !Number.isInteger(raw.paraIdx) || !Number.isInteger(raw.controlIdx)) throw new Error("그림을 HWP/HWPX 문서에 추가하지 못했습니다.");
    const properties: Record<string, unknown> = { ...object.properties, width, height, horzOffset, vertOffset, textWrap: object.textWrap, treatAsChar: false, description: object.description };
    delete properties.instanceId;
    delete properties.scInstId;
    delete properties.zOrder;
    if (!parseJson<{ ok: boolean }>(document.setPictureProperties(0, raw.paraIdx, raw.controlIdx, JSON.stringify(properties)), "그림 속성 저장").ok) {
      throw new Error("그림 위치·크기·배치 속성을 저장하지 못했습니다.");
    }
    return;
  }

  const shapeType = object.kind === "ellipse" ? "ellipse" : "rectangle";
  const created = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(document.createShapeControl(JSON.stringify({
    sectionIdx: 0, paraIdx: paraIndex, charOffset: object.anchorCharOffset,
    width, height, horzOffset, vertOffset, treatAsChar: false, textWrap: object.textWrap,
    shapeType, description: object.description,
  })), "도형 저장");
  if (!created.ok || !Number.isInteger(created.paraIdx) || !Number.isInteger(created.controlIdx)) throw new Error("도형을 HWP/HWPX 문서에 추가하지 못했습니다.");
  if (object.kind === "textBox" && !parseJson<{ ok: boolean }>(document.setTextBoxAt(created.paraIdx, created.controlIdx, true), "글상자 저장").ok) {
    throw new Error("글상자 편집 영역을 문서에 추가하지 못했습니다.");
  }
  const properties: Record<string, unknown> = { ...object.properties, width, height, horzOffset, vertOffset, textWrap: object.textWrap, treatAsChar: false, description: object.description };
  delete properties.instanceId;
  delete properties.scInstId;
  delete properties.zOrder;
  if (!parseJson<{ ok: boolean }>(document.setShapeProperties(0, created.paraIdx, created.controlIdx, JSON.stringify(properties)), "도형 속성 저장").ok) {
    throw new Error("도형 선·채우기 또는 위치 속성을 저장하지 못했습니다.");
  }
  if (object.kind !== "textBox") return;
  const paragraphs = object.textParagraphs ?? [];
  if (!paragraphs.length) throw new Error("글상자에는 최소 한 문단이 필요합니다.");
  for (let cellParaIndex = 0; cellParaIndex < paragraphs.length; cellParaIndex += 1) {
    const paragraph = paragraphs[cellParaIndex]!;
    if (cellParaIndex > 0) {
      const previous = paragraphs[cellParaIndex - 1]!;
      const splitPath = JSON.stringify([{ controlIndex: created.controlIdx, cellIndex: 0, cellParaIndex: cellParaIndex - 1 }]);
      if (!parseJson<{ ok: boolean }>(document.splitParagraphInCellByPath(0, created.paraIdx, splitPath, previous.text.length), "글상자 문단 분리").ok) {
        throw new Error("글상자 문단 구성을 저장하지 못했습니다.");
      }
    }
    const path = JSON.stringify([{ controlIndex: created.controlIdx, cellIndex: 0, cellParaIndex }]);
    if (paragraph.text && !parseJson<{ ok: boolean }>(document.insertTextInCellByPath(0, created.paraIdx, path, 0, paragraph.text), "글상자 텍스트 저장").ok) {
      throw new Error("글상자 텍스트를 저장하지 못했습니다.");
    }
    if (Object.keys(paragraph.paragraphFormat).length) {
      const format = { ...paragraph.paragraphFormat };
      for (const key of ["marginLeft", "marginRight", "indent"] as const) if (typeof format[key] === "number") format[key] = Math.round(format[key]! * 150);
      if (!parseJson<{ ok: boolean }>(document.applyParaFormatInCell(0, created.paraIdx, created.controlIdx, 0, cellParaIndex, JSON.stringify(format)), "글상자 문단 서식 저장").ok) {
        throw new Error("글상자 문단 서식을 저장하지 못했습니다.");
      }
    }
    for (const run of paragraph.characterFormats) {
      if (run.end <= run.start) continue;
      const format: Record<string, unknown> = { ...run.format };
      const family = typeof format.fontFamily === "string" ? format.fontFamily : "";
      delete format.fontFamily;
      if (family) format.fontIds = Array.from({ length: 7 }, (_, language) => document.findOrCreateFontIdForLang(language, family));
      if (!parseJson<{ ok: boolean }>(document.applyCharFormatInCellByPath(0, created.paraIdx, path, run.start, run.end, JSON.stringify(format)), "글상자 글자 서식 저장").ok) {
        throw new Error("글상자 글자 서식을 저장하지 못했습니다.");
      }
    }
  }
}

const SUPPORTED_TEXT_CHAR_PROPERTIES = new Set([
  "fontFamily", "fontFamilies", "fontSize", "bold", "italic", "underline", "strikethrough", "charShapeId",
]);
const SUPPORTED_TEXT_PARA_PROPERTIES = new Set([
  "alignment", "marginLeft", "marginRight", "indent", "pageBreakBefore", "paraShapeId",
]);
const SUPPORTED_TEXT_PAGE_PROPERTIES = new Set([
  "width", "height", "marginLeft", "marginRight", "marginTop", "marginBottom",
  "marginHeader", "marginFooter", "marginGutter", "landscape", "binding",
]);
const SUPPORTED_TABLE_PROPERTIES = new Set([
  "tableWidth", "tableHeight", "outerLeft", "outerRight", "outerTop", "outerBottom", "restrictInPage",
  "horzAlign", "horzOffset", "vertOffset",
]);
const SUPPORTED_TABLE_CELL_PROPERTIES = new Set([
  "width", "height", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "borderFillId", "borderLeft", "borderRight", "borderTop", "borderBottom", "fillType", "fillColor", "diagonalLine",
]);

interface PlainTextImportDefaults {
  paragraph: Record<string, unknown>;
  character: Record<string, unknown>;
  page: Record<string, unknown>;
  section: Record<string, unknown>;
  columns: Record<string, unknown>;
  styles: unknown;
  styleAt: Record<string, unknown>;
  table: Record<string, unknown>;
  tableCell: Record<string, unknown>;
  tableParagraph: Record<string, unknown>;
  tableCharacter: Record<string, unknown>;
  tableStyleAt: Record<string, unknown>;
  picture: Record<string, unknown>;
  rectangle: Record<string, unknown>;
  ellipse: Record<string, unknown>;
  textBox: Record<string, unknown>;
}

let plainTextImportDefaults: PlainTextImportDefaults | undefined;

function getPlainTextImportDefaults(): PlainTextImportDefaults {
  if (plainTextImportDefaults) return plainTextImportDefaults;
  const blank = HwpDocument.createEmpty();
  try {
    const created = parseJson<{ version?: string }>(blank.createBlankDocument(), "새 문서 호환성 기준");
    if (!created.version) throw new Error("새 문서 호환성 기준을 만들지 못했습니다.");
    const createdTable = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(blank.createTable(0, 0, 0, 1, 1), "기본 표 기준");
    if (!createdTable.ok) throw new Error("기본 표 기준을 만들지 못했습니다.");
    const objectDefaults = getDocumentObjectImportDefaults();
    plainTextImportDefaults = {
      paragraph: parseJson(blank.getParaPropertiesAt(0, 0), "기본 문단 서식"),
      character: parseJson(blank.getCharPropertiesAt(0, 0, 0), "기본 글자 서식"),
      page: parseJson(blank.getPageDef(0), "기본 용지 설정"),
      section: parseJson(blank.getSectionDef(0), "기본 구역 설정"),
      columns: parseJson(blank.getColumnDef(0), "기본 단 설정"),
      styles: parseJson(blank.getStyleList(), "기본 스타일 목록"),
      styleAt: parseJson(blank.getStyleAt(0, 0), "기본 문단 스타일"),
      table: parseJson(blank.getTableProperties(0, createdTable.paraIdx, createdTable.controlIdx), "기본 표 속성"),
      tableCell: parseJson(blank.getCellOwnProperties(0, createdTable.paraIdx, createdTable.controlIdx, 0), "기본 셀 속성"),
      tableParagraph: parseJson(blank.getCellParaPropertiesAt(0, createdTable.paraIdx, createdTable.controlIdx, 0, 0), "기본 셀 문단 서식"),
      tableCharacter: parseJson(blank.getCellCharPropertiesAt(0, createdTable.paraIdx, createdTable.controlIdx, 0, 0, 0), "기본 셀 글자 서식"),
      tableStyleAt: parseJson(blank.getCellStyleAt(0, createdTable.paraIdx, createdTable.controlIdx, 0, 0), "기본 셀 스타일"),
      ...objectDefaults,
    };
    return plainTextImportDefaults;
  } finally {
    blank.free();
  }
}

const PROBE_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6WQAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
let objectImportDefaults: Pick<PlainTextImportDefaults, "picture" | "rectangle" | "ellipse" | "textBox"> | undefined;

function getDocumentObjectImportDefaults(): Pick<PlainTextImportDefaults, "picture" | "rectangle" | "ellipse" | "textBox"> {
  if (objectImportDefaults) return objectImportDefaults;
  const document = HwpDocument.createEmpty();
  try {
    const created = parseJson<{ version?: string }>(document.createBlankDocument(), "개체 호환성 기준 문서");
    if (!created.version) throw new Error("개체 호환성 기준을 만들지 못했습니다.");
    document.insertPictureEx(JSON.stringify({
      sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 7200, height: 7200,
      naturalWidthPx: 1, naturalHeightPx: 1, extension: "png", paperOffsetXHu: 0, paperOffsetYHu: 0,
    }), PROBE_PNG);
    const picture = parseJson<RawDocumentObject[]>(document.getObjects(), "기본 그림 개체").find((item) => item.kind === "picture");
    if (!picture) throw new Error("기본 그림 개체를 만들지 못했습니다.");
    const pictureProperties = parseJson<Record<string, unknown>>(document.getPictureProperties(0, picture.para, picture.controlIndex), "기본 그림 속성");
    const shapeProperties = (shapeType: "rectangle" | "ellipse", textBox = false) => {
      const result = parseJson<{ ok: boolean; paraIdx: number; controlIdx: number }>(document.createShapeControl(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 7200, height: 7200,
        horzOffset: 0, vertOffset: 0, treatAsChar: false, textWrap: "InFrontOfText", shapeType,
      })), "기본 도형 개체");
      if (!result.ok) throw new Error("기본 도형 개체를 만들지 못했습니다.");
      if (textBox && !parseJson<{ ok: boolean }>(document.setTextBoxAt(result.paraIdx, result.controlIdx, true), "기본 글상자 설정").ok) {
        throw new Error("기본 글상자 모델을 만들지 못했습니다.");
      }
      return parseJson<Record<string, unknown>>(document.getShapeProperties(0, result.paraIdx, result.controlIdx), "기본 도형 속성");
    };
    objectImportDefaults = {
      picture: pictureProperties,
      rectangle: shapeProperties("rectangle"),
      ellipse: shapeProperties("ellipse"),
      textBox: shapeProperties("rectangle", true),
    };
    return objectImportDefaults;
  } finally {
    document.free();
  }
}

type RhwpTableControl = { ctrlId?: string; para?: number; controlIndex?: number };

const OBJECT_LAYER_OPS = new Set(["image", "rectangle", "ellipse"]);
const COMMON_OBJECT_PROPERTY_DIFFERENCES = new Set([
  "width", "height", "horzOffset", "vertOffset", "textWrap", "description", "zOrder", "instanceId", "scInstId",
]);
const SHAPE_STYLE_PROPERTY_DIFFERENCES = new Set([
  ...COMMON_OBJECT_PROPERTY_DIFFERENCES,
  "borderColor", "borderWidth", "borderAttr", "fillType", "fillBgColor", "fillPatColor", "fillPatType", "fillAlpha",
  "tbMarginLeft", "tbMarginRight", "tbMarginTop", "tbMarginBottom",
]);
// RHWP represents an uncropped image's final source pixel as a 75-HU inset
// from the image extent (1/96 inch at its 96-dpi logical image scale).
const DEFAULT_IMAGE_CROP_INSET_HU = 75;

function onlySupportedObjectPropertyDifferences(
  value: Record<string, unknown>,
  baseline: Record<string, unknown>,
  allowedDifferences: ReadonlySet<string>,
): boolean {
  const keys = new Set([...Object.keys(value), ...Object.keys(baseline)]);
  return [...keys].every((key) => allowedDifferences.has(key) || stableJson(value[key]) === stableJson(baseline[key]));
}

function layerTextWrap(value: string | undefined): DocumentObjectTextWrap | undefined {
  const normalized = value?.replace(/[\s_-]/gu, "").toLowerCase();
  const values: Record<string, DocumentObjectTextWrap> = {
    square: "Square", topandbottom: "TopAndBottom", tight: "Tight", through: "Through",
    behindtext: "BehindText", infrontoftext: "InFrontOfText",
  };
  return normalized ? values[normalized] : undefined;
}

function objectLayerIndex(document: HwpDocument, pages: readonly number[]): Map<string, RawObjectLayer[]> {
  const result = new Map<string, RawObjectLayer[]>();
  for (const pageIndex of new Set(pages)) {
    const tree = parseJson<{ root?: RawLayerTreeNode }>(document.getPageLayerTreeWithProfile(pageIndex, "screen", true), "개체 조판 정보");
    const visit = (node: RawLayerTreeNode, inheritedLayer?: RawLayerTreeNode["layer"]): void => {
      const layer = node.layer ?? inheritedLayer;
      const stableIndex = layer?.stableIndex;
      if (Number.isInteger(stableIndex)) {
        for (const op of node.ops ?? []) {
          if (typeof op.type !== "string" || !OBJECT_LAYER_OPS.has(op.type)) continue;
          const bbox = typeof op.bbox === "object" && op.bbox !== null ? op.bbox as Record<string, unknown> : node.bounds;
          if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every((value) => typeof value === "number" && Number.isFinite(value))) continue;
          const entry: RawObjectLayer = {
            pageIndex, stableIndex: stableIndex!, zOrder: Number.isFinite(layer?.zOrder) ? layer!.zOrder! : 0,
            textWrap: String(layer?.textWrap ?? (typeof op.wrap === "string" ? op.wrap : "")),
            bounds: { x: bbox.x as number, y: bbox.y as number, width: bbox.width as number, height: bbox.height as number },
            op,
          };
          const key = `${pageIndex}:${stableIndex}`;
          const bucket = result.get(key) ?? [];
          bucket.push(entry); result.set(key, bucket);
        }
      }
      for (const child of node.children ?? []) visit(child, layer);
      if (node.child) visit(node.child, layer);
    };
    if (tree.root) visit(tree.root);
  }
  return result;
}

function objectAnchorOffset(control: RawDocumentControl, allControls: readonly RawDocumentControl[]): number {
  if (!Number.isInteger(control.pos) || !Number.isInteger(control.para)) throw new Error("개체 앵커 위치를 확인할 수 없습니다.");
  const before = allControls.filter((candidate) => candidate.para === control.para
    && Number.isInteger(candidate.pos)
    && ((candidate.pos ?? 0) < control.pos! || ((candidate.pos ?? 0) === control.pos! && (candidate.controlIndex ?? 0) < (control.controlIndex ?? 0)))
    && ["secd", "cold", "gso", "tbl"].includes(candidate.ctrlId ?? "")).length;
  return Math.max(0, control.pos! - before * 8);
}

function rasterDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 24 && ascii(0, 8) === "\x89PNG\r\n\x1a\n") return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 26 && ascii(0, 2) === "BM") return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!; const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function extractTextBoxParagraphs(
  document: HwpDocument,
  paraIndex: number,
  controlIndex: number,
  defaults: PlainTextImportDefaults,
): Array<Omit<PlainTextParagraph, "table" | "objects">> {
  const paragraphCount = document.getCellParagraphCountByPath(0, paraIndex, JSON.stringify([{ controlIndex, cellIndex: 0, cellParaIndex: 0 }]));
  if (!Number.isInteger(paragraphCount) || paragraphCount < 1 || paragraphCount > 256) throw new Error("글상자 문단 수가 지원 범위를 벗어났습니다.");
  const paragraphs: Array<Omit<PlainTextParagraph, "table" | "objects">> = [];
  for (let cellParaIndex = 0; cellParaIndex < paragraphCount; cellParaIndex += 1) {
    const path = JSON.stringify([{ controlIndex, cellIndex: 0, cellParaIndex }]);
    const length = document.getCellParagraphLengthByPath(0, paraIndex, path);
    const text = document.getTextInCellByPath(0, paraIndex, path, 0, length);
    if (!Number.isInteger(length) || length < 0 || text.length !== length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
      throw new Error("글상자에 변환할 수 없는 필드나 개체가 있습니다.");
    }
    const rawParagraph = parseJson<Record<string, unknown>>(document.getCellParaPropertiesAt(0, paraIndex, controlIndex, 0, cellParaIndex), "글상자 문단 속성");
    const checkable = { ...rawParagraph };
    if (rawParagraph.fillType === "none") {
      checkable.patternColor = defaults.tableParagraph.patternColor;
      checkable.patternType = defaults.tableParagraph.patternType;
    }
    if (unsupportedDifferenceKeys(checkable, defaults.tableParagraph, SUPPORTED_TEXT_PARA_PROPERTIES).length) throw new Error("글상자에 지원되지 않는 문단 속성이 있습니다.");
    if (rawParagraph.pageBreakBefore === true) throw new Error("글상자 문단의 쪽 나누기는 아직 지원되지 않습니다.");
    const styleAt = parseJson<Record<string, unknown>>(document.getCellStyleAt(0, paraIndex, controlIndex, 0, cellParaIndex), "글상자 문단 스타일");
    if (stableJson(styleAt) !== stableJson(defaults.tableStyleAt)) throw new Error("글상자에 사용자 지정 문단 스타일이 있습니다.");
    const alignment = rawParagraph.alignment;
    if (alignment !== "left" && alignment !== "center" && alignment !== "right" && alignment !== "justify") throw new Error("글상자 문단 정렬을 확인하지 못했습니다.");
    const paragraphFormat: ParagraphFormat = { alignment };
    for (const key of ["marginLeft", "marginRight", "indent"] as const) {
      const value = rawParagraph[key];
      if (typeof value === "number" && Number.isFinite(value) && stableJson(value) !== stableJson(defaults.tableParagraph[key])) paragraphFormat[key] = value;
    }
    const characterFormats: PlainTextParagraph["characterFormats"] = [];
    if (length > 0) {
      const runs = parseJson<Array<{ startOffset: number; endOffset: number }>>(document.getCharShapeRunsInCellByPath(0, paraIndex, path, 0, length), "글상자 글자 서식 구간");
      let nextOffset = 0;
      for (const run of runs) {
        if (!Number.isInteger(run.startOffset) || !Number.isInteger(run.endOffset) || run.startOffset !== nextOffset || run.endOffset <= run.startOffset || run.endOffset > length) {
          throw new Error("글상자 글자 서식 범위가 이어지지 않습니다.");
        }
        const props = parseJson<Record<string, unknown>>(document.getCellCharPropertiesAt(0, paraIndex, controlIndex, 0, cellParaIndex, run.startOffset), "글상자 글자 속성");
        const checkableCharacter = { ...props };
        if (props.fillType === "none") {
          checkableCharacter.patternColor = defaults.tableCharacter.patternColor;
          checkableCharacter.patternType = defaults.tableCharacter.patternType;
        }
        if (unsupportedDifferenceKeys(checkableCharacter, defaults.tableCharacter, SUPPORTED_TEXT_CHAR_PROPERTIES).length) throw new Error("글상자에 지원되지 않는 글자 효과가 있습니다.");
        if (typeof props.fontFamily !== "string" || !Array.isArray(props.fontFamilies) || !props.fontFamilies.every((family) => family === props.fontFamily)) {
          throw new Error("글상자에서 언어별 글꼴을 안전하게 보존할 수 없습니다.");
        }
        const format: CharacterFormat = {};
        if (props.fontFamily !== "함초롬바탕") format.fontFamily = props.fontFamily;
        if (typeof props.fontSize === "number" && Number.isFinite(props.fontSize) && props.fontSize !== 1200) format.fontSize = props.fontSize;
        for (const key of ["bold", "italic", "underline", "strikethrough"] as const) if (props[key] === true) format[key] = true;
        if (Object.keys(format).length) characterFormats.push({ start: run.startOffset, end: run.endOffset, format });
        nextOffset = run.endOffset;
      }
      if (nextOffset !== length) throw new Error("글상자 글자 서식 범위가 끝까지 이어지지 않습니다.");
    }
    paragraphs.push({ text, pageBreakBefore: false, paragraphFormat, characterFormats });
  }
  return paragraphs;
}

function extractObjectsForHanul(
  document: HwpDocument,
  objects: RawDocumentObject[],
  controls: RawDocumentControl[],
  cycles: RawObjectCycle[],
  defaults: PlainTextImportDefaults,
): Map<number, PlainTextObject[]> {
  if (objects.some((item) => item.kind !== "picture" && item.kind !== "shape" && item.kind !== "table")) {
    throw new Error("지원하지 않는 개체 종류가 포함되어 있습니다.");
  }
  const floatingObjects = objects.filter((item) => item.kind === "picture" || item.kind === "shape");
  const objectControls = controls.filter((item) => item.ctrlId === "gso");
  if (objectControls.length !== floatingObjects.length) throw new Error("개체 목록과 문서 컨트롤이 일치하지 않습니다.");
  const pages = cycles.map((cycle) => cycle.page);
  const layerMap = objectLayerIndex(document, pages);
  const byParagraph = new Map<number, PlainTextObject[]>();
  const seen = new Set<string>();
  for (const object of floatingObjects) {
    if (!Number.isInteger(object.para) || !Number.isInteger(object.controlIndex)) throw new Error("개체가 문단에 연결되어 있지 않습니다.");
    const paraIndex = object.para;
    const key = `${paraIndex}:${object.controlIndex}`;
    if (seen.has(key)) throw new Error("중복된 개체 컨트롤이 있습니다.");
    seen.add(key);
    const control = objectControls.find((candidate) => candidate.para === paraIndex && candidate.controlIndex === object.controlIndex);
    const cycle = cycles.find((candidate) => candidate.para === paraIndex && candidate.controlIndex === object.controlIndex);
    if (!control || !cycle || !Number.isInteger(cycle.page) || cycle.page < 0) throw new Error("개체의 앵커 문단 또는 페이지가 없습니다.");
    const isTextBox = object.kind === "shape" && document.getTextBoxControlIndex(0, paraIndex) === object.controlIndex;
    if (object.listId != null && !isTextBox) throw new Error("표나 다른 개체 안에 중첩된 개체는 아직 지원되지 않습니다.");
    const objectLayers = layerMap.get(`${cycle.page}:${object.controlIndex}`) ?? [];
    const primaryLayers = objectLayers.filter((entry) => (entry.op.type === "image") === (object.kind === "picture")
      && (entry.op.type === "rectangle" || entry.op.type === "ellipse" || entry.op.type === "image"));
    const unique = new Map(primaryLayers.map((entry) => [`${entry.op.type}:${stableJson(entry.bounds)}`, entry]));
    if (unique.size !== 1) throw new Error(`개체 ${object.controlIndex}의 기본 도형/그림 레이어를 하나로 식별할 수 없습니다.`);
    const layer = [...unique.values()][0]!;
    const raw = parseJson<Record<string, unknown>>(object.kind === "picture"
      ? document.getPictureProperties(0, paraIndex, object.controlIndex)
      : document.getShapeProperties(0, paraIndex, object.controlIndex), "개체 속성");
    const width = raw.width; const height = raw.height; const horzOffset = raw.horzOffset; const vertOffset = raw.vertOffset;
    if (![width, height, horzOffset, vertOffset].every((value) => typeof value === "number" && Number.isFinite(value)) || (width as number) <= 0 || (height as number) <= 0) {
      throw new Error("개체의 위치 또는 크기가 올바르지 않습니다.");
    }
    const wrap = layerTextWrap(typeof raw.textWrap === "string" ? raw.textWrap : layer.textWrap);
    const layerWrap = layerTextWrap(layer.textWrap);
    if (!wrap || !layerWrap || wrap !== layerWrap || (wrap !== "BehindText" && wrap !== "InFrontOfText")) throw new Error("이 개체의 글 배치 방식은 아직 독립 엔진에서 재현할 수 없습니다.");
    if (raw.treatAsChar !== false || raw.horzRelTo !== "Paper" || raw.vertRelTo !== "Paper" || raw.horzAlign !== "Left" || raw.vertAlign !== "Top") {
      throw new Error("종이 기준 왼쪽 위에 고정되지 않은 개체는 아직 지원되지 않습니다.");
    }
    if (!["rectangle", "ellipse", "image"].includes(String(layer.op.type))) throw new Error("복합 도형 또는 개체 효과가 포함되어 있습니다.");
    const transform = typeof layer.op.transform === "object" && layer.op.transform !== null ? layer.op.transform as Record<string, unknown> : {};
    if (transform.rotation !== 0 || transform.horzFlip !== false || transform.vertFlip !== false) throw new Error("회전 또는 뒤집기가 적용된 개체는 아직 지원되지 않습니다.");
    const objectKind = object.kind === "picture" ? "picture" : isTextBox ? "textBox" : layer.op.type === "ellipse" ? "ellipse" : "rectangle";
    const baseline = object.kind === "picture" ? defaults.picture : objectKind === "textBox" ? defaults.textBox : objectKind === "ellipse" ? defaults.ellipse : defaults.rectangle;
    const allowed = object.kind === "picture"
      ? new Set([...COMMON_OBJECT_PROPERTY_DIFFERENCES, "originalWidth", "originalHeight", "cropRight", "cropBottom"])
      : SHAPE_STYLE_PROPERTY_DIFFERENCES;
    if (!onlySupportedObjectPropertyDifferences(raw, baseline, allowed)) {
      const keys = new Set([...Object.keys(raw), ...Object.keys(baseline)]);
      const differences = [...keys].filter((key) => !allowed.has(key) && stableJson(raw[key]) !== stableJson(baseline[key]));
      throw new Error(`개체에 아직 지원되지 않는 효과나 저장 속성이 있습니다: ${differences.map((key) => `${key}=${stableJson(raw[key])} (기본 ${stableJson(baseline[key])})`).join(", ")}`);
    }
    if (typeof raw.description !== "string" || typeof raw.rotationAngle !== "number" || raw.rotationAngle !== 0 || raw.horzFlip !== false || raw.vertFlip !== false) {
      throw new Error("개체 설명 또는 변환 속성을 확인하지 못했습니다.");
    }
    if (object.kind === "picture") {
      const crop = ["cropLeft", "cropTop", "cropRight", "cropBottom"].map((key) => raw[key]);
      if (crop.some((value) => typeof value !== "number") || raw.cropLeft !== 0 || raw.cropTop !== 0
        || raw.cropRight !== Number(raw.originalWidth) - DEFAULT_IMAGE_CROP_INSET_HU
        || raw.cropBottom !== Number(raw.originalHeight) - DEFAULT_IMAGE_CROP_INSET_HU
        || raw.hasCaption !== false || raw.transparency !== 0 || raw.brightness !== 0 || raw.contrast !== 0 || raw.effect !== "RealPic") {
        throw new Error("자르기·캡션·그림 효과가 있는 그림은 아직 지원되지 않습니다.");
      }
    }
    if (objectKind === "textBox" && (layer.op.type !== "rectangle" || layer.op.cornerRadius !== 0 || raw.tbVerticalAlign !== "Top")) {
      throw new Error("단순한 위쪽 정렬 글상자만 독립 엔진에서 편집할 수 있습니다.");
    }
    if (object.kind === "shape") {
      const style = typeof layer.op.style === "object" && layer.op.style !== null ? layer.op.style as Record<string, unknown> : {};
      if (style.strokeDash !== "solid" || typeof style.fillColor !== "string" || typeof style.strokeColor !== "string"
        || typeof style.strokeWidth !== "number" || !Number.isFinite(style.opacity)) throw new Error("도형 선·채우기 속성을 재현할 수 없습니다.");
    }
    const expectedX = (horzOffset as number) / 75; const expectedY = (vertOffset as number) / 75;
    if (Math.abs(layer.bounds.x - expectedX) > 1.5 || Math.abs(layer.bounds.y - expectedY) > 1.5
      || Math.abs(layer.bounds.width - (width as number) / 75) > 1.5 || Math.abs(layer.bounds.height - (height as number) / 75) > 1.5) {
      throw new Error("개체의 페이지 좌표와 저장 위치 속성이 일치하지 않습니다.");
    }
    let imageData: Uint8Array | undefined;
    let imageExtension: string | undefined;
    let naturalWidthPx: number | undefined;
    let naturalHeightPx: number | undefined;
    if (object.kind === "picture") {
      const mime = layer.op.mime;
      const extension = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : mime === "image/bmp" ? "bmp" : "";
      const sourceKey = layer.op.sourceImageKey;
      if (!extension || typeof sourceKey !== "string") throw new Error("그림 원본 바이트 또는 형식을 찾을 수 없습니다.");
      imageData = new Uint8Array(document.getSourceImageBytes(sourceKey));
      imageExtension = extension;
      const dimensions = rasterDimensions(imageData);
      if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error("그림 파일의 원본 크기를 확인하지 못했습니다.");
      naturalWidthPx = dimensions.width; naturalHeightPx = dimensions.height;
    }
    const objectValue: PlainTextObject = {
      id: `0:${paraIndex}:${object.controlIndex}:${objectKind}`,
      kind: objectKind, sectionIndex: 0, paragraphIndex: paraIndex, controlIndex: object.controlIndex,
      pageIndex: cycle.page,
      bounds: { pageIndex: cycle.page, ...layer.bounds },
      zOrder: Number.isFinite(layer.zOrder) ? layer.zOrder : Number.isFinite(cycle.z) ? cycle.z! : 0,
      widthMm: rhwpUnitsToMillimeters(width as number), heightMm: rhwpUnitsToMillimeters(height as number),
      offsetXmm: rhwpUnitsToMillimeters(horzOffset as number), offsetYmm: rhwpUnitsToMillimeters(vertOffset as number),
      textWrap: wrap, treatAsCharacter: false, description: raw.description,
      anchorCharOffset: objectAnchorOffset(control, controls),
      properties: raw,
      ...(imageData ? { imageData, imageExtension, naturalWidthPx, naturalHeightPx, preserveAspectRatio: true } : {}),
      ...(object.kind === "shape" ? {
        shapeType: layer.op.type === "ellipse" ? "ellipse" as const : "rectangle" as const,
        paint: {
          fillColor: (layer.op.style as Record<string, unknown>).fillColor as string,
          strokeColor: (layer.op.style as Record<string, unknown>).strokeColor as string,
          strokeWidth: (layer.op.style as Record<string, unknown>).strokeWidth as number,
          opacity: (layer.op.style as Record<string, unknown>).opacity as number,
        },
      } : {}),
      ...(objectKind === "textBox" ? {
        textMarginsMm: {
          left: rhwpUnitsToMillimeters(Number(raw.tbMarginLeft ?? 0)), right: rhwpUnitsToMillimeters(Number(raw.tbMarginRight ?? 0)),
          top: rhwpUnitsToMillimeters(Number(raw.tbMarginTop ?? 0)), bottom: rhwpUnitsToMillimeters(Number(raw.tbMarginBottom ?? 0)),
        },
        textParagraphs: extractTextBoxParagraphs(document, paraIndex, object.controlIndex, defaults),
      } : {}),
    };
    const bucket = byParagraph.get(paraIndex) ?? [];
    bucket.push(objectValue); byParagraph.set(paraIndex, bucket);
  }
  for (const bucket of byParagraph.values()) bucket.sort((left, right) => left.anchorCharOffset - right.anchorCharOffset || left.zOrder - right.zOrder);
  return byParagraph;
}

function extractTableForHanul(
  document: HwpDocument,
  control: RhwpTableControl,
  defaults: PlainTextImportDefaults,
): { table: PlainTextTable; lastPage: number } {
  const paragraphIndex = control.para;
  const controlIndex = control.controlIndex;
  if (!Number.isInteger(paragraphIndex) || !Number.isInteger(controlIndex)) throw new Error("표의 문단 위치가 확인되지 않습니다.");
  const para = paragraphIndex!; const ctrl = controlIndex!;
  const dimensions = parseJson<{ rowCount: number; colCount: number; cellCount: number }>(
    document.getTableDimensions(0, para, ctrl), "표 크기",
  );
  if (!Number.isInteger(dimensions.rowCount) || dimensions.rowCount < 1 || dimensions.rowCount > 50
    || !Number.isInteger(dimensions.colCount) || dimensions.colCount < 1 || dimensions.colCount > 20
    || !Number.isInteger(dimensions.cellCount) || dimensions.cellCount < 1 || dimensions.cellCount > 1000) {
    throw new Error("표 크기가 Hanul 독립 엔진의 지원 범위를 벗어났습니다.");
  }
  const tableProperties = parseJson<Record<string, unknown>>(document.getTableProperties(0, para, ctrl), "표 속성");
  const unsupportedTableProperties = unsupportedDifferenceKeys(tableProperties, defaults.table, SUPPORTED_TABLE_PROPERTIES);
  if (unsupportedTableProperties.length) {
    throw new Error(`표에 아직 보존할 수 없는 표 속성이 있습니다: ${unsupportedTableProperties.map((key) => `${key}=${stableJson(tableProperties[key])} (기본 ${stableJson(defaults.table[key])})`).join(", ")}`);
  }
  // The independent block layout currently represents tables as standalone
  // flow blocks. Inline/floating positioning and repeated header rows stay on
  // RHWP until the layout engine can reproduce their placement.
  for (const key of ["treatAsChar", "textWrap", "horzRelTo", "vertRelTo", "vertAlign", "restrictInPage", "allowOverlap", "keepWithAnchor"]) {
    if (key !== "restrictInPage" && stableJson(tableProperties[key]) !== stableJson(defaults.table[key])) {
      throw new Error(`표 배치 속성 ${key}는 아직 지원되지 않습니다.`);
    }
  }
  if (tableProperties.horzAlign !== "Left" && tableProperties.horzAlign !== "Center" && tableProperties.horzAlign !== "Right") {
    throw new Error("표의 가로 정렬 값이 올바르지 않습니다.");
  }
  if (![tableProperties.horzOffset, tableProperties.vertOffset].every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("표의 위치 값이 올바르지 않습니다.");
  }
  if (tableProperties.hasCaption === true || tableProperties.repeatHeader === true || Number(tableProperties.pageBreak ?? 0) !== 0) {
    throw new Error("캡션, 반복 제목 행 또는 표 쪽 나눔이 있는 표는 아직 지원되지 않습니다.");
  }

  const cells: PlainTextTableCell[] = [];
  const grid = Array.from({ length: dimensions.rowCount }, () => Array(dimensions.colCount).fill(false) as boolean[]);
  const widthEquations: Array<{ col: number; span: number; widthMm: number }> = [];
  let lastPage = 0;
  for (let cellIndex = 0; cellIndex < dimensions.cellCount; cellIndex += 1) {
    const info = parseJson<{ row: number; col: number; rowSpan: number; colSpan: number }>(
      document.getCellInfo(0, para, ctrl, cellIndex), "셀 위치",
    );
    if (![info.row, info.col, info.rowSpan, info.colSpan].every(Number.isInteger)
      || info.row < 0 || info.col < 0 || info.rowSpan < 1 || info.colSpan < 1
      || info.row + info.rowSpan > dimensions.rowCount || info.col + info.colSpan > dimensions.colCount) {
      throw new Error("표 병합 범위가 올바르지 않습니다.");
    }
    for (let row = info.row; row < info.row + info.rowSpan; row += 1) {
      for (let col = info.col; col < info.col + info.colSpan; col += 1) {
        if (grid[row][col]) throw new Error("표 셀 병합 영역이 서로 겹칩니다.");
        grid[row][col] = true;
      }
    }

    const properties = parseJson<Record<string, unknown>>(document.getCellOwnProperties(0, para, ctrl, cellIndex), "셀 속성");
    if (properties.fillType !== "none" && properties.fillType !== "solid") {
      throw new Error(`셀 ${cellIndex + 1}의 채우기 형식은 아직 지원되지 않습니다.`);
    }
    const checkableCellProperties = { ...properties };
    if (properties.fillType === "none" || properties.fillType === "solid") {
      checkableCellProperties.patternColor = defaults.tableCell.patternColor;
      checkableCellProperties.patternType = defaults.tableCell.patternType;
    }
    const unsupportedCellProperties = unsupportedDifferenceKeys(checkableCellProperties, defaults.tableCell, SUPPORTED_TABLE_CELL_PROPERTIES);
    if (unsupportedCellProperties.length) {
      throw new Error(`셀 ${cellIndex + 1}에 아직 보존할 수 없는 셀 속성이 있습니다: ${unsupportedCellProperties.map((key) => `${key}=${stableJson(properties[key])} (기본 ${stableJson(defaults.tableCell[key])})`).join(", ")}`);
    }
    if (properties.diagonalLine !== undefined && properties.diagonalLine !== 0 && properties.diagonalLine !== defaults.tableCell.diagonalLine) {
      throw new Error(`셀 ${cellIndex + 1}에 독립 엔진이 아직 그릴 수 없는 대각선 테두리가 있습니다.`);
    }
    const widthRaw = properties.width; const heightRaw = properties.height;
    if (typeof widthRaw !== "number" || !Number.isFinite(widthRaw) || widthRaw <= 0
      || typeof heightRaw !== "number" || !Number.isFinite(heightRaw) || heightRaw < 0) {
      throw new Error(`셀 ${cellIndex + 1}의 크기를 확인하지 못했습니다.`);
    }
    const widthMm = rhwpUnitsToMillimeters(widthRaw);
    widthEquations.push({ col: info.col, span: info.colSpan, widthMm });

    const paragraphCount = document.getCellParagraphCount(0, para, ctrl, cellIndex);
    if (!Number.isInteger(paragraphCount) || paragraphCount < 1 || paragraphCount > 1000) throw new Error("셀 문단 수가 올바르지 않습니다.");
    const paragraphs: PlainTextTableCell["paragraphs"] = [];
    for (let cellParaIndex = 0; cellParaIndex < paragraphCount; cellParaIndex += 1) {
      const length = document.getCellParagraphLength(0, para, ctrl, cellIndex, cellParaIndex);
      const text = document.getTextInCell(0, para, ctrl, cellIndex, cellParaIndex, 0, length);
      if (text.length !== length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
        throw new Error(`셀 ${cellIndex + 1}에 문자 외 개체나 제어 데이터가 있습니다.`);
      }
      const rawParagraph = parseJson<Record<string, unknown>>(
        document.getCellParaPropertiesAt(0, para, ctrl, cellIndex, cellParaIndex), "셀 문단 서식",
      );
      const checkableCellParagraph = { ...rawParagraph };
      if (rawParagraph.fillType === "none" || rawParagraph.fillType === "solid") {
        checkableCellParagraph.patternColor = defaults.tableParagraph.patternColor;
        checkableCellParagraph.patternType = defaults.tableParagraph.patternType;
      }
      const paragraphUnsupported = unsupportedDifferenceKeys(checkableCellParagraph, defaults.tableParagraph, SUPPORTED_TEXT_PARA_PROPERTIES);
      if (paragraphUnsupported.length) throw new Error(`셀 ${cellIndex + 1}의 문단 서식은 아직 지원되지 않습니다: ${paragraphUnsupported.join(", ")}`);
      if (rawParagraph.pageBreakBefore === true) throw new Error("셀 안의 쪽 나누기는 아직 지원되지 않습니다.");
      const styleAt = parseJson<Record<string, unknown>>(
        document.getCellStyleAt(0, para, ctrl, cellIndex, cellParaIndex), "셀 문단 스타일",
      );
      if (stableJson(styleAt) !== stableJson(defaults.tableStyleAt)) throw new Error("사용자 지정 셀 문단 스타일은 아직 지원되지 않습니다.");
      const paragraphFormat: ParagraphFormat = {};
      const alignment = rawParagraph.alignment;
      if (alignment !== "left" && alignment !== "center" && alignment !== "right" && alignment !== "justify") {
        throw new Error("셀 문단 정렬 값이 올바르지 않습니다.");
      }
      paragraphFormat.alignment = alignment;
      for (const key of ["marginLeft", "marginRight", "indent"] as const) {
        const value = rawParagraph[key];
        if (value !== undefined && stableJson(value) !== stableJson(defaults.tableParagraph[key])) {
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`셀 문단 ${key} 값이 올바르지 않습니다.`);
          paragraphFormat[key] = value;
        }
      }

      const characterFormats: PlainTextTableCell["paragraphs"][number]["characterFormats"] = [];
      if (length > 0) {
        const runs = parseJson<Array<{ startOffset: number; endOffset: number }>>(
          document.getCharShapeRunsInCellByPath(0, para, JSON.stringify([{ controlIndex: ctrl, cellIndex, cellParaIndex }]), 0, length), "셀 글자 서식 구간",
        );
        let nextOffset = 0;
        for (const run of runs) {
          if (!Number.isInteger(run.startOffset) || !Number.isInteger(run.endOffset) || run.startOffset !== nextOffset
            || run.endOffset <= run.startOffset || run.endOffset > length) throw new Error(`셀 ${cellIndex + 1}의 글자 서식 구간이 불완전합니다.`);
          const charProperties = parseJson<Record<string, unknown>>(
            document.getCellCharPropertiesAtByPath(0, para, JSON.stringify([{ controlIndex: ctrl, cellIndex, cellParaIndex }]), run.startOffset),
            "셀 글자 서식",
          );
          const checkableCellCharacter = { ...charProperties };
          if (charProperties.fillType === "none" || charProperties.fillType === "solid") {
            checkableCellCharacter.patternColor = defaults.tableCharacter.patternColor;
            checkableCellCharacter.patternType = defaults.tableCharacter.patternType;
          }
          const charUnsupported = unsupportedDifferenceKeys(checkableCellCharacter, defaults.tableCharacter, SUPPORTED_TEXT_CHAR_PROPERTIES);
          if (charUnsupported.length) throw new Error(`셀 ${cellIndex + 1}의 글자 서식은 아직 지원되지 않습니다: ${charUnsupported.join(", ")}`);
          const family = charProperties.fontFamily; const families = charProperties.fontFamilies;
          if (typeof family !== "string" || !Array.isArray(families) || !families.every((item) => item === family)) {
            throw new Error(`셀 ${cellIndex + 1}에서 언어별 글꼴을 사용합니다.`);
          }
          const format: CharacterFormat = {};
          const modelDefaults: Record<keyof CharacterFormat, unknown> = {
            fontFamily: "함초롬바탕", fontSize: 1200, bold: false, italic: false, underline: false, strikethrough: false,
          };
          for (const key of ["fontFamily", "fontSize", "bold", "italic", "underline", "strikethrough"] as const) {
            const value = charProperties[key];
            if (value === undefined || stableJson(value) === stableJson(modelDefaults[key])) continue;
            if (key === "fontFamily" && typeof value === "string") format.fontFamily = value;
            else if (key === "fontSize" && typeof value === "number" && Number.isFinite(value)) format.fontSize = value;
            else if ((key === "bold" || key === "italic" || key === "underline" || key === "strikethrough") && typeof value === "boolean") format[key] = value;
            else throw new Error(`셀 ${cellIndex + 1}의 글자 속성을 변환할 수 없습니다.`);
          }
          if (Object.keys(format).length) characterFormats.push({ start: run.startOffset, end: run.endOffset, format });
          nextOffset = run.endOffset;
        }
        if (nextOffset !== length) throw new Error(`셀 ${cellIndex + 1}의 글자 서식 범위가 텍스트 길이와 다릅니다.`);
      }
      paragraphs.push({ text, pageBreakBefore: false, paragraphFormat, characterFormats });
    }
    const endParagraph = paragraphCount - 1;
    const endLength = document.getCellParagraphLength(0, para, ctrl, cellIndex, endParagraph);
    const cellRect = parseJson<CursorRectangle>(
      document.getCursorRectInCell(0, para, ctrl, cellIndex, endParagraph, endLength), "셀 끝 위치",
    );
    lastPage = Math.max(lastPage, cellRect.pageIndex);
    cells.push({
      row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan,
      widthMm, heightMm: rhwpUnitsToMillimeters(heightRaw), properties, paragraphs,
    });
  }
  if (grid.some((row) => row.some((covered) => !covered))) throw new Error("표 셀의 병합 범위가 격자를 완전히 채우지 않습니다.");
  const tableWidthRaw = tableProperties.tableWidth;
  if (typeof tableWidthRaw !== "number" || !Number.isFinite(tableWidthRaw) || tableWidthRaw <= 0) {
    throw new Error("표 전체 너비를 확인하지 못했습니다.");
  }
  const columnWidthsMm = solveTableColumnWidths(
    dimensions.colCount,
    widthEquations,
    rhwpUnitsToMillimeters(tableWidthRaw),
  );
  if (columnWidthsMm.some((width) => !Number.isFinite(width) || width <= 0)) throw new Error("표의 각 열 너비를 확인하지 못했습니다.");
  return {
    table: { rowCount: dimensions.rowCount, colCount: dimensions.colCount, columnWidthsMm, properties: tableProperties, cells },
    lastPage,
  };
}

/**
 * RHWP reports a merged cell's total width, not the widths of its constituent
 * columns. Solve the row/cell width constraints rather than assuming every
 * merged cell is evenly split; reject underdetermined or inconsistent grids.
 */
function solveTableColumnWidths(
  columnCount: number,
  cells: Array<{ col: number; span: number; widthMm: number }>,
  tableWidthMm: number,
): number[] {
  const equations = [
    ...cells.map((cell) => {
      const row = Array(columnCount).fill(0) as number[];
      for (let col = cell.col; col < cell.col + cell.span; col += 1) row[col] = 1;
      return [...row, cell.widthMm];
    }),
    [...Array(columnCount).fill(1), tableWidthMm],
  ];
  const pivotColumns: number[] = [];
  let pivotRow = 0;
  for (let col = 0; col < columnCount && pivotRow < equations.length; col += 1) {
    let candidate = pivotRow;
    for (let row = pivotRow + 1; row < equations.length; row += 1) {
      if (Math.abs(equations[row][col]) > Math.abs(equations[candidate][col])) candidate = row;
    }
    if (Math.abs(equations[candidate][col]) < 1e-9) continue;
    [equations[pivotRow], equations[candidate]] = [equations[candidate], equations[pivotRow]];
    const pivot = equations[pivotRow][col];
    for (let item = col; item <= columnCount; item += 1) equations[pivotRow][item] /= pivot;
    for (let row = 0; row < equations.length; row += 1) {
      if (row === pivotRow) continue;
      const factor = equations[row][col];
      if (Math.abs(factor) < 1e-9) continue;
      for (let item = col; item <= columnCount; item += 1) equations[row][item] -= factor * equations[pivotRow][item];
    }
    pivotColumns.push(col);
    pivotRow += 1;
  }
  for (const equation of equations) {
    if (equation.slice(0, columnCount).every((value) => Math.abs(value) < 1e-7) && Math.abs(equation[columnCount]) > 0.75) {
      throw new Error("셀 너비와 표 전체 너비가 서로 일치하지 않습니다.");
    }
  }
  if (pivotColumns.length !== columnCount) throw new Error("병합 셀 정보만으로 각 열 너비를 안전하게 계산할 수 없습니다.");
  const widths = Array(columnCount).fill(0) as number[];
  for (let row = 0; row < pivotColumns.length; row += 1) widths[pivotColumns[row]] = equations[row][columnCount];
  for (const cell of cells) {
    const width = widths.slice(cell.col, cell.col + cell.span).reduce((sum, value) => sum + value, 0);
    if (Math.abs(width - cell.widthMm) > 0.75) throw new Error("셀 너비가 표의 열 너비와 일치하지 않습니다.");
  }
  if (Math.abs(widths.reduce((sum, value) => sum + value, 0) - tableWidthMm) > 0.75) {
    throw new Error("표 전체 너비가 열 너비 합계와 일치하지 않습니다.");
  }
  return widths;
}

/**
 * Copy only a positively identified text-and-table subset out of RHWP. Any control,
 * style, field, section, or format we cannot represent keeps the document on the
 * RHWP session so opening it never silently flattens unsupported content.
 */
function extractPlainTextImport(document: HwpDocument): ImportedPlainTextDocument | null {
  const reject = (reason: string) => {
    reportEnginePerformance({ phase: "text-import-rejected", reason });
    return null;
  };
  try {
    const format = document.getSourceFormat().toLowerCase();
    if (format !== "hwp" && format !== "hwpx") return reject("unsupported file format");
    if (document.getSectionCount() !== 1) return reject("multiple sections");

    const info = parseJson<Record<string, unknown>>(document.getDocumentInfo(), "문서 정보");
    if (info.encrypted === true || info.hwp3Variant === true) return reject("encrypted or HWP 3 document");
    const defaults = getPlainTextImportDefaults();
    const section = parseJson<Record<string, unknown>>(document.getSectionDef(0), "구역 설정");
    if (stableJson(section) !== stableJson(defaults.section)) return reject("non-default section properties");
    const columns = parseJson<Record<string, unknown>>(document.getColumnDef(0), "단 설정");
    if (stableJson(columns) !== stableJson(defaults.columns)) return reject("column settings are not supported yet");
    const styles = parseJson<unknown>(document.getStyleList(), "스타일 목록");
    if (stableJson(styles) !== stableJson(defaults.styles)) return reject("custom document styles");

    const controls = parseJson<RawDocumentControl[]>(document.getControls(), "문서 컨트롤");
    const tableControls = controls.filter((item) => item.ctrlId === "tbl");
    if (controls.some((item) => item.ctrlId !== "secd" && item.ctrlId !== "cold" && item.ctrlId !== "tbl" && item.ctrlId !== "gso")
      || controls.filter((item) => item.ctrlId === "secd").length !== 1
      || controls.filter((item) => item.ctrlId === "cold").length !== 1) return reject("unsupported document controls");
    const tableByParagraph = new Map<number, RawDocumentControl>();
    for (const control of tableControls) {
      if (!Number.isInteger(control.para) || !Number.isInteger(control.controlIndex) || tableByParagraph.has(control.para!)) {
        return reject("multiple or unaddressable table controls in a paragraph");
      }
      tableByParagraph.set(control.para!, control);
    }
    const documentObjects = parseJson<RawDocumentObject[]>(document.getObjects(), "문서 개체 목록");
    const tableObjects = documentObjects.filter((item) => item.kind === "table");
    if (tableObjects.length !== tableControls.length || tableObjects.some((object) =>
      !tableControls.some((control) => control.para === object.para && control.controlIndex === object.controlIndex))) {
      return reject("table object list does not match table controls");
    }
    const objectCycles = parseJson<RawObjectCycle[]>(document.getObjectCycle(), "개체 페이지 위치");
    const objectByParagraph = extractObjectsForHanul(document, documentObjects, controls, objectCycles, defaults);
    if (parseJson<unknown[]>(document.getFieldList(), "필드 목록").length !== 0
      || parseJson<unknown[]>(document.getBookmarks(), "책갈피 목록").length !== 0) return reject("fields or bookmarks");
    for (const isHeader of [true, false]) {
      for (const applyTo of [0, 1, 2]) {
        const headerFooter = parseJson<{ exists?: boolean }>(document.getHeaderFooter(0, isHeader, applyTo), "머리말·꼬리말");
        if (headerFooter.exists) return reject("headers or footers");
      }
    }

    const rawPage = parseJson<PageDefinition>(document.getPageDef(0), "용지 설정");
    if (!hasOnlySupportedDifferences(rawPage as unknown as Record<string, unknown>, defaults.page, SUPPORTED_TEXT_PAGE_PROPERTIES)) return reject("unsupported page properties");
    const pageDefinition: PageDefinition = {
      ...rawPage,
      width: rhwpUnitsToMillimeters(rawPage.width),
      height: rhwpUnitsToMillimeters(rawPage.height),
      marginLeft: rhwpUnitsToMillimeters(rawPage.marginLeft),
      marginRight: rhwpUnitsToMillimeters(rawPage.marginRight),
      marginTop: rhwpUnitsToMillimeters(rawPage.marginTop),
      marginBottom: rhwpUnitsToMillimeters(rawPage.marginBottom),
      marginHeader: rhwpUnitsToMillimeters(rawPage.marginHeader),
      marginFooter: rhwpUnitsToMillimeters(rawPage.marginFooter),
      marginGutter: rhwpUnitsToMillimeters(rawPage.marginGutter),
    };

    const paragraphs: ImportedPlainTextDocument["paragraphs"][number][] = [];
    let previousLastPage = 0;
    const paragraphCount = document.getParagraphCount(0);
    if (paragraphCount < 1) return reject("empty paragraph list");
    for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
      const length = document.getParagraphLength(0, paragraphIndex);
      const text = document.getTextRange(0, paragraphIndex, 0, length);
      if (text.length !== length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return reject("paragraph contains unsupported control characters");

      const tableControl = tableByParagraph.get(paragraphIndex);
      if (tableControl) {
        if (objectByParagraph.has(paragraphIndex)) return reject(`table paragraph ${paragraphIndex + 1} also contains floating objects`);
        // A table anchored in the middle of a body paragraph cannot yet be
        // represented as an ordered block without changing its position.
        if (text.length) return reject(`table at paragraph ${paragraphIndex + 1} shares an anchor with body text`);
        const paraProperties = parseJson<Record<string, unknown>>(document.getParaPropertiesAt(0, paragraphIndex), "표 앵커 문단 서식");
        const checkableAnchorProperties = { ...paraProperties };
        if (paraProperties.fillType === "none") {
          checkableAnchorProperties.patternColor = defaults.paragraph.patternColor;
          checkableAnchorProperties.patternType = defaults.paragraph.patternType;
        }
        const unsupportedAnchorProperties = unsupportedDifferenceKeys(checkableAnchorProperties, defaults.paragraph, new Set(["pageBreakBefore", "paraShapeId"]));
        if (unsupportedAnchorProperties.length) {
          return reject(`table anchor paragraph ${paragraphIndex + 1} has unsupported formatting: ${unsupportedAnchorProperties.map((key) => `${key}=${stableJson(paraProperties[key])} (기본 ${stableJson(defaults.paragraph[key])})`).join(", ")}`);
        }
        const tableStart = parseJson<CursorRectangle>(document.getCursorRect(0, paragraphIndex, 0), "표 시작 위치");
        const pageBreakBefore = paraProperties.pageBreakBefore === true || (paragraphIndex > 0 && tableStart.pageIndex > previousLastPage);
        const extracted = extractTableForHanul(document, tableControl, defaults);
        paragraphs.push({
          text: "", pageBreakBefore, paragraphFormat: {}, characterFormats: [], table: extracted.table,
        });
        previousLastPage = Math.max(tableStart.pageIndex, extracted.lastPage);
        continue;
      }

      const paraProperties = parseJson<Record<string, unknown>>(document.getParaPropertiesAt(0, paragraphIndex), "문단 서식");
      const checkableParaProperties = { ...paraProperties };
      // HWPX exporters commonly write meaningless pattern defaults even when
      // the paragraph has no fill. The independent model has no paragraph fill;
      // ignore those dormant values only when fillType explicitly says `none`.
      if (paraProperties.fillType === "none") {
        checkableParaProperties.patternColor = defaults.paragraph.patternColor;
        checkableParaProperties.patternType = defaults.paragraph.patternType;
      }
      const unsupportedParagraphProperties = unsupportedDifferenceKeys(checkableParaProperties, defaults.paragraph, SUPPORTED_TEXT_PARA_PROPERTIES);
      if (unsupportedParagraphProperties.length) return reject(`paragraph ${paragraphIndex + 1} has unsupported paragraph formatting: ${unsupportedParagraphProperties.map((key) => `${key}=${stableJson(paraProperties[key])} (default ${stableJson(defaults.paragraph[key])})`).join(", ")}`);
      const styleAt = parseJson<Record<string, unknown>>(document.getStyleAt(0, paragraphIndex), "문단 스타일");
      if (stableJson(styleAt) !== stableJson(defaults.styleAt)) return reject(`paragraph ${paragraphIndex + 1} uses a non-default style`);

      const paragraphFormat: ParagraphFormat = {};
      const alignment = paraProperties.alignment;
      if (alignment !== "left" && alignment !== "center" && alignment !== "right" && alignment !== "justify") {
        return reject(`paragraph ${paragraphIndex + 1} has an unsupported alignment`);
      }
      // The Hanul model defaults to left alignment; HWP's normal paragraph
      // default is justified, so record that value even when it matches RHWP's
      // blank-document baseline.
      paragraphFormat.alignment = alignment;
      for (const key of ["marginLeft", "marginRight", "indent"] as const) {
        const value = paraProperties[key];
        if (value !== undefined && stableJson(value) !== stableJson(defaults.paragraph[key])) {
          if (typeof value === "number" && Number.isFinite(value)) paragraphFormat[key] = value;
          else return reject(`paragraph ${paragraphIndex + 1} has an unsupported paragraph value`);
        }
      }
      if (typeof paraProperties.pageBreakBefore !== "boolean") return reject(`paragraph ${paragraphIndex + 1} has an unknown page-break flag`);
      const startRect = parseJson<CursorRectangle>(document.getCursorRect(0, paragraphIndex, 0), "문단 위치");
      const pageBreakBefore = paraProperties.pageBreakBefore === true || (paragraphIndex > 0 && startRect.pageIndex > previousLastPage);

      const characterFormats: PlainTextParagraph["characterFormats"] = [];
      if (length > 0) {
        const runs = parseJson<Array<{ startOffset: number; endOffset: number }>>(document.getCharShapeRuns(0, paragraphIndex, 0, length), "글자 서식 구간");
        let nextOffset = 0;
        for (const run of runs) {
          if (!Number.isInteger(run.startOffset) || !Number.isInteger(run.endOffset) || run.startOffset !== nextOffset
            || run.endOffset <= run.startOffset || run.endOffset > length) return reject(`paragraph ${paragraphIndex + 1} has incomplete character runs`);
          const properties = parseJson<Record<string, unknown>>(document.getCharPropertiesAt(0, paragraphIndex, run.startOffset), "글자 서식");
          const checkableCharacterProperties = { ...properties };
          if (properties.fillType === "none") {
            checkableCharacterProperties.patternColor = defaults.character.patternColor;
            checkableCharacterProperties.patternType = defaults.character.patternType;
          }
          const unsupportedCharacterProperties = unsupportedDifferenceKeys(checkableCharacterProperties, defaults.character, SUPPORTED_TEXT_CHAR_PROPERTIES);
          if (unsupportedCharacterProperties.length) return reject(`paragraph ${paragraphIndex + 1} has unsupported character formatting: ${unsupportedCharacterProperties.map((key) => `${key}=${stableJson(properties[key])} (default ${stableJson(defaults.character[key])})`).join(", ")}`);
          const family = properties.fontFamily;
          const families = properties.fontFamilies;
          if (typeof family !== "string" || !Array.isArray(families) || !families.every((item) => item === family)) return reject(`paragraph ${paragraphIndex + 1} uses language-specific fonts`);
          const characterFormat: CharacterFormat = {};
          const textModelDefaults: Record<keyof CharacterFormat, unknown> = {
            fontFamily: "함초롬바탕", fontSize: 1200, bold: false, italic: false, underline: false, strikethrough: false,
          };
          for (const key of ["fontFamily", "fontSize", "bold", "italic", "underline", "strikethrough"] as const) {
            const value = properties[key];
            if (value === undefined || stableJson(value) === stableJson(textModelDefaults[key])) continue;
            if (key === "fontFamily" && typeof value === "string") characterFormat.fontFamily = value;
            else if (key === "fontSize" && typeof value === "number" && Number.isFinite(value)) characterFormat.fontSize = value;
            else if ((key === "bold" || key === "italic" || key === "underline" || key === "strikethrough") && typeof value === "boolean") characterFormat[key] = value;
            else return reject(`paragraph ${paragraphIndex + 1} has an unsupported character property`);
          }
          if (Object.keys(characterFormat).length) characterFormats.push({ start: run.startOffset, end: run.endOffset, format: characterFormat });
          nextOffset = run.endOffset;
        }
        if (nextOffset !== length) return reject(`paragraph ${paragraphIndex + 1} character run coverage is incomplete`);
      }
      const objects = objectByParagraph.get(paragraphIndex) ?? [];
      if (objects.some((object) => object.anchorCharOffset > text.length || object.pageIndex !== startRect.pageIndex)) {
        return reject(`paragraph ${paragraphIndex + 1} has an object anchor outside the represented page range`);
      }
      paragraphs.push({ text, pageBreakBefore, paragraphFormat, characterFormats, ...(objects.length ? { objects } : {}) });

      const lastOffset = length > 0 ? length - 1 : 0;
      previousLastPage = parseJson<CursorRectangle>(document.getCursorRect(0, paragraphIndex, lastOffset), "문단 끝 위치").pageIndex;
    }
    return { paragraphs, pageDefinition, sourceFormat: format };
  } catch (cause) {
    // A failed or unknown structure is left on the RHWP path; the format adapter
    // remains responsible for presenting any actual parse error to the user.
    reportEnginePerformance({ phase: "text-import-rejected", reason: cause instanceof Error ? cause.message : String(cause) });
    return null;
  }
}

const hanulTextSerializer: PlainTextSerializer = {
  serialize: serializePlainTextWithRhwp,
};

export const hanulDocumentEngine: DocumentEngine = Object.freeze({
  id: "hanul",
  async open(bytes: Uint8Array): Promise<DocumentSession> {
    await initializeEngine();
    const document = new HwpDocument(bytes);
    const imported = extractPlainTextImport(document);
    if (!imported) return new RhwpDocumentSession(document);
    document.free();
    const session = new HanulTextDocumentSession(
      hanulTextSerializer,
      imported.paragraphs,
      imported.pageDefinition,
      imported.sourceFormat,
    );
    reportEnginePerformance({ phase: "open-hanul-text-import", format: imported.sourceFormat, paragraphs: imported.paragraphs.length, pageCount: session.pageCount });
    return session;
  },
  async createBlank(): Promise<DocumentSession> {
    await initializeEngine();
    return new HanulTextDocumentSession(hanulTextSerializer);
  },
});

export const rhwpDocumentEngine: DocumentEngine = Object.freeze({
  id: "rhwp",
  open: loadHwpDocument,
  createBlank: createNewHwpDocumentSession,
});

export function wrapHwpDocument(document: HwpDocument): DocumentSession {
  return new RhwpDocumentSession(document);
}
