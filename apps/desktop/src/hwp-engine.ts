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
  TextPosition,
} from "./document-engine";
import { HanulTextDocumentSession, type ImportedPlainTextDocument, type PlainTextParagraph, type PlainTextSerializer } from "./text-document-engine";

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
  kind: "picture" | "shape";
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

  insertShape(position: TextPosition, kind: "rectangle" | "textBox", widthMm: number, heightMm: number) {
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
      let bounds = {
        pageIndex,
        x: (Number.isFinite(props.horzOffset) ? props.horzOffset! : 0) / 75,
        y: (Number.isFinite(props.vertOffset) ? props.vertOffset! : 0) / 75,
        width: props.width! / 75,
        height: props.height! / 75,
      };
      if (item.kind === "shape") {
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
      const kind: DocumentObjectKind = item.kind === "picture" ? "picture" : hasTextBox ? "textBox" : "rectangle";
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

interface PlainTextImportDefaults {
  paragraph: Record<string, unknown>;
  character: Record<string, unknown>;
  page: Record<string, unknown>;
  section: Record<string, unknown>;
  columns: Record<string, unknown>;
  styles: unknown;
  styleAt: Record<string, unknown>;
}

let plainTextImportDefaults: PlainTextImportDefaults | undefined;

function getPlainTextImportDefaults(): PlainTextImportDefaults {
  if (plainTextImportDefaults) return plainTextImportDefaults;
  const blank = HwpDocument.createEmpty();
  try {
    const created = parseJson<{ version?: string }>(blank.createBlankDocument(), "새 문서 호환성 기준");
    if (!created.version) throw new Error("새 문서 호환성 기준을 만들지 못했습니다.");
    plainTextImportDefaults = {
      paragraph: parseJson(blank.getParaPropertiesAt(0, 0), "기본 문단 서식"),
      character: parseJson(blank.getCharPropertiesAt(0, 0, 0), "기본 글자 서식"),
      page: parseJson(blank.getPageDef(0), "기본 용지 설정"),
      section: parseJson(blank.getSectionDef(0), "기본 구역 설정"),
      columns: parseJson(blank.getColumnDef(0), "기본 단 설정"),
      styles: parseJson(blank.getStyleList(), "기본 스타일 목록"),
      styleAt: parseJson(blank.getStyleAt(0, 0), "기본 문단 스타일"),
    };
    return plainTextImportDefaults;
  } finally {
    blank.free();
  }
}

/**
 * Copy only a positively identified simple-text subset out of RHWP. Any control,
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

    const controls = parseJson<Array<{ ctrlId?: string }>>(document.getControls(), "문서 컨트롤");
    if (controls.length !== 2 || controls.filter((item) => item.ctrlId === "secd").length !== 1
      || controls.filter((item) => item.ctrlId === "cold").length !== 1) return reject("unsupported document controls");
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
      paragraphs.push({ text, pageBreakBefore, paragraphFormat, characterFormats });

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
