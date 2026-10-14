import init, { HwpDocument, type DocumentExport } from "@rhwp/core";
import wasmUrl from "@rhwp/core/rhwp_bg.wasm?url";
import type {
  CellPathSegment,
  CharacterFormat,
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
  | { kind: "snapshot"; beforeSnapshotId: number; afterSnapshotId: number; beforeAddress: TextPosition; afterAddress: TextPosition }
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
    if (hit.isTextBox || hit.isField) {
      throw new Error("글상자와 필드 내부 텍스트는 아직 편집할 수 없습니다.");
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
    return parseJson<PageDefinition>(this.document.getPageDef(sectionIndex), "용지 설정");
  }

  setPageDefinition(position: TextPosition, updates: Partial<PageDefinition>) {
    const current = this.pageDefinition(position.sectionIndex);
    const next = { ...current, ...updates };
    const numeric = [next.width, next.height, next.marginLeft, next.marginRight, next.marginTop, next.marginBottom];
    if (numeric.some((value) => !Number.isFinite(value) || value < 0) || next.width < 10000 || next.height < 10000) {
      throw new Error("용지 크기와 여백 값을 확인하세요.");
    }
    if (next.marginLeft + next.marginRight >= next.width || next.marginTop + next.marginBottom >= next.height) {
      throw new Error("여백이 용지 크기보다 작아야 합니다.");
    }
    return this.mutateWithSnapshot(position, "용지 설정", () => {
      const raw = this.document.setPageDef(position.sectionIndex, JSON.stringify(next));
      if (!parseJson<{ ok: boolean }>(raw, "용지 설정").ok) throw new Error("용지 설정을 바꾸지 못했습니다.");
    }, 0);
  }

  insertHeaderFooterText(position: TextPosition, kind: HeaderFooterKind, text: string) {
    if (this.isCellPosition(position)) throw new Error("표 셀 안에서는 머리말이나 꼬리말을 추가할 수 없습니다.");
    if (!text.trim()) throw new Error("머리말이나 꼬리말 내용을 입력하세요.");
    if (/[\r\n]/.test(text)) throw new Error("현재 머리말·꼬리말 삽입은 한 문단의 텍스트만 지원합니다.");
    const isHeader = kind === "header";
    const applyTo = 0; // RHWP's section-wide "양 쪽" target.
    return this.mutateWithSnapshot(position, isHeader ? "머리말 삽입" : "꼬리말 삽입", () => {
      const current = parseJson<{ ok: boolean; exists: boolean }>(
        this.document.getHeaderFooter(position.sectionIndex, isHeader, applyTo),
        isHeader ? "머리말 조회" : "꼬리말 조회",
      );
      if (!current.ok) throw new Error("머리말·꼬리말 상태를 확인하지 못했습니다.");
      if (!current.exists) {
        const created = parseJson<{ ok: boolean }>(
          this.document.createHeaderFooter(position.sectionIndex, isHeader, applyTo),
          isHeader ? "머리말 생성" : "꼬리말 생성",
        );
        if (!created.ok) throw new Error("머리말·꼬리말을 만들지 못했습니다.");
      }
      const paragraph = parseJson<{ ok: boolean; paraCount: number; charCount: number }>(
        this.document.getHeaderFooterParaInfo(position.sectionIndex, isHeader, applyTo, 0),
        "머리말·꼬리말 문단 조회",
      );
      if (!paragraph.ok || paragraph.paraCount < 1 || !Number.isInteger(paragraph.charCount) || paragraph.charCount < 0) {
        throw new Error("머리말·꼬리말 문단을 편집할 수 없습니다.");
      }
      const inserted = parseJson<{ ok: boolean }>(
        this.document.insertTextInHeaderFooter(
          position.sectionIndex,
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

  insertPicture(position: TextPosition, imageData: Uint8Array, extension: string, naturalWidthPx: number, naturalHeightPx: number, width: number, height: number) {
    if (!imageData.byteLength || !Number.isInteger(naturalWidthPx) || !Number.isInteger(naturalHeightPx) || naturalWidthPx < 1 || naturalHeightPx < 1 || width < 1 || height < 1) {
      throw new Error("그림 데이터나 크기가 올바르지 않습니다.");
    }
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

  searchText(query: string, includeCells = true): SearchMatch[] {
    const needle = query.trim();
    if (!needle) return [];
    const hits = parseJson<RawSearchHit[]>(this.document.searchAllText(needle, false, includeCells), "문서 검색");
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

  replaceAllText(query: string, replacement: string) {
    if (!query.trim()) throw new Error("찾을 내용을 입력하세요.");
    if (/[\r\n]/.test(replacement)) throw new Error("바꾸기 내용에는 문단 나눔을 넣을 수 없습니다.");
    const matches = this.searchText(query, true);
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
      return { bytes: result.takeBytes(), report };
    } finally {
      result.free();
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
  ) {
    const beforeSnapshotId = this.document.saveSnapshot();
    let afterSnapshotId: number | undefined;
    try {
      const nextOffset = mutate();
      this.invalidatePages(invalidateFromPage);
      const afterAddress = this.positionAtAddress(address, typeof nextOffset === "number" ? nextOffset : address.charOffset);
      afterSnapshotId = this.document.saveSnapshot();
      this.undoStack.push({
        kind: "snapshot",
        beforeSnapshotId,
        afterSnapshotId,
        beforeAddress: { ...address },
        afterAddress: { ...afterAddress },
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
        return this.positionAtAddress(operation.beforeAddress, operation.beforeAddress.charOffset);
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
        return this.positionAtAddress(operation.afterAddress, operation.afterAddress.charOffset);
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

export const rhwpDocumentEngine: DocumentEngine = Object.freeze({
  id: "rhwp",
  open: loadHwpDocument,
  createBlank: createNewHwpDocumentSession,
});

export function wrapHwpDocument(document: HwpDocument): DocumentSession {
  return new RhwpDocumentSession(document);
}
