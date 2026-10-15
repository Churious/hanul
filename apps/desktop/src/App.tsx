import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import DOMPurify from "dompurify";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, remove, stat, writeFile } from "@tauri-apps/plugin-fs";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ImeInputGate } from "./ime-input";
import { previewObjectDrag } from "./object-drag";
import { LatestFrame } from "./pointer-frame";
import { hanulDocumentEngine } from "./hwp-engine";
import { canContinueAfterSave, commitLatestDocumentLoad, DocumentSaveLock, LatestDocumentLoad, resolveUnsavedChoice, type PendingDocumentAction } from "./document-lifecycle";
import type {
  DocumentSession,
  DocumentInfo,
  CompatibilityEngine,
  DocumentCompatibilityReport,
  CharacterFormat,
  DocumentObject,
  DocumentObjectTextWrap,
  DocumentStyle,
  ExportResult,
  HeaderFooterFieldKind,
  HeaderFooterScope,
  PageDefinition,
  ParagraphFormat,
  SearchMatch,
  SearchOptions,
  SelectionRectangle,
  TableLayoutInfo,
  TableUpdates,
  TableCommand,
  TextPosition,
} from "./document-engine";
import {
  clampZoom,
  formatFileSize,
  sanitizeRenderedSvg,
  validateDocumentFile,
} from "./document-utils";
import { canSaveWithCompatibility, compatibilityIssueMessage, withSerializerLosses } from "./document-compatibility";
import { FileMenu } from "./components/ribbon/FileMenu";
import { createFileMenuItems, type FileMenuCommand } from "./components/ribbon/file-menu-model";
import { forgetRecentDocument, readRecentDocuments, rememberRecentDocument } from "./recent-documents";
import "./App.css";

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <rect x="1" y="1" width="30" height="30" rx="3" fill="currentColor" />
        <path
          d="M9 10h14M9 16h14M9 22h8"
          stroke="white"
          strokeLinecap="square"
          strokeWidth="2"
        />
      </svg>
    </span>
  );
}

function Icon({
  name,
  size = 18,
}: {
  name: "open" | "minus" | "plus" | "chevron-left" | "chevron-right" | "file" | "edit" | "save" | "undo" | "redo";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    open: (
      <>
        <path d="M3.5 7.5h6l2 2h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 19V9a1.5 1.5 0 0 1 1.5-1.5Z" />
        <path d="M2.5 12h19" />
      </>
    ),
    minus: <path d="M5 12h14" />,
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    "chevron-left": <path d="m14.5 5-7 7 7 7" />,
    "chevron-right": <path d="m9.5 5 7 7-7 7" />,
    file: (
      <>
        <path d="M6 2.75h8l5 5v13.5H6a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2Z" />
        <path d="M14 3v5h5M8 13h8M8 16.5h8" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="m16.5 3.5 4 4L9 19l-5 1 1-5Z" />
      </>
    ),
    save: (
      <>
        <path d="M5 3.5h12l3.5 3.5v13.5H3.5v-17Z" />
        <path d="M7 3.5v6h9v-6M7 20v-7h10v7" />
      </>
    ),
    undo: (
      <>
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10a6 6 0 0 1 0 12h-2" />
      </>
    ),
    redo: (
      <>
        <path d="m15 14 5-5-5-5" />
        <path d="M20 9H10a6 6 0 0 0 0 12h2" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}

interface PendingDocument {
  name: string;
  size: number;
  file?: File;
  path?: string;
  createNew?: true;
}

type DialogState = "unsaved" | "loss" | "pdf-loss" | null;

type DocumentInfoDialogState = {
  fileName: string;
  filePath: string;
  fileFormat: string;
  fileSize: number;
  info: DocumentInfo;
};

type PrintRequest = "print";

interface PdfExportCandidate {
  result: ExportResult;
  outputPath: string;
}

interface SaveExportCandidate {
  result: ExportResult;
  sourceEngine: Exclude<CompatibilityEngine, "rhwp-inspector">;
  editRevision: number;
}

function getBaseName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function errorDetail(cause: unknown, fallback: string) {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  if (cause && typeof cause === "object") {
    if ("message" in cause && typeof cause.message === "string" && cause.message) return cause.message;
    try {
      const serialized = JSON.stringify(cause);
      if (serialized && serialized !== "{}") return serialized.slice(0, 500);
    } catch {
      // Fall through to the user-facing fallback for non-serializable errors.
    }
  }
  return fallback;
}

function reportAppPerformance(phase: string, details: Record<string, number | string>) {
  if (import.meta.env.DEV) console.info(`[Hanul performance] ${phase}`, details);
}

const measuredInitialPages = new WeakMap<DocumentSession, Set<number>>();

function shouldMeasureInitialPage(session: DocumentSession, pageIndex: number) {
  if (!import.meta.env.DEV || pageIndex > 2) return false;
  let measuredPages = measuredInitialPages.get(session);
  if (!measuredPages) {
    measuredPages = new Set<number>();
    measuredInitialPages.set(session, measuredPages);
  }
  if (measuredPages.has(pageIndex)) return false;
  measuredPages.add(pageIndex);
  return true;
}

type EditorSelection = { anchor: TextPosition; focus: TextPosition };

function sameEditorScope(left: TextPosition, right: TextPosition) {
  return left.sectionIndex === right.sectionIndex
    && left.parentParagraphIndex === right.parentParagraphIndex
    && (left.cellPath ?? []).length === (right.cellPath ?? []).length
    && (left.cellPath ?? []).every((segment, index) => {
      const other = right.cellPath?.[index];
      return other?.controlIndex === segment.controlIndex && other.cellIndex === segment.cellIndex;
    });
}

function compareEditorPositions(left: TextPosition, right: TextPosition) {
  return left.paragraphIndex - right.paragraphIndex || left.charOffset - right.charOffset;
}

function isRangeSelection(selection: EditorSelection | null) {
  return Boolean(
    selection
      && sameEditorScope(selection.anchor, selection.focus)
      && compareEditorPositions(selection.anchor, selection.focus) !== 0,
  );
}

function placeImeInput(input: HTMLTextAreaElement, svg: SVGSVGElement, position: TextPosition) {
  const bounds = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  if (bounds.width <= 0 || bounds.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return;
  const left = bounds.left + ((position.cursorRect.x - viewBox.x) / viewBox.width) * bounds.width;
  const top = bounds.top + ((position.cursorRect.y - viewBox.y) / viewBox.height) * bounds.height;
  const height = (position.cursorRect.height / viewBox.height) * bounds.height;
  input.style.left = `${left}px`;
  input.style.top = `${top}px`;
  if (Number.isFinite(height) && height > 0) input.style.height = `${height}px`;
}

type RibbonTab = "편집" | "입력" | "보기" | "서식" | "쪽" | "보안" | "검토" | "도구";

type PageSetupForm = {
  widthMm: number;
  heightMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  orientation: "portrait" | "landscape";
};

type PageSetupDialogState = {
  position: TextPosition;
  form: PageSetupForm;
};

type FormatDialogTab = "character" | "paragraph";

type CharacterFormatDraft = {
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
};

type ParagraphFormatDraft = {
  alignment: NonNullable<ParagraphFormat["alignment"]>;
  lineSpacing: number;
  lineSpacingType: NonNullable<ParagraphFormat["lineSpacingType"]>;
  marginLeftMm: number;
  marginRightMm: number;
  indentMm: number;
  spacingBeforeMm: number;
  spacingAfterMm: number;
};

type HeaderFooterDialogState = {
  kind: "header" | "footer";
  scope: HeaderFooterScope;
  text: string;
  exists: boolean;
};

type ObjectEditDraft = {
  widthMm: string;
  heightMm: string;
  offsetXmm: string;
  offsetYmm: string;
  textWrap: DocumentObjectTextWrap;
};

type ObjectPointerDrag = {
  object: DocumentObject;
  pageIndex: number;
  startX: number;
  startY: number;
  resize: boolean;
};

type PointerGestureMetrics = {
  kind: "object-drag" | "table-selection" | "text-selection" | "text-box-selection";
  startedAt: number;
  rawMoves: number;
  frames: number;
  lastFrameAt: number | null;
  maxFrameGapMs: number;
};

type PendingPointerSample = {
  pageIndex: number;
  x: number;
  y: number;
};

type TableContextMenuPosition = { left: number; top: number };
type ObjectContextMenuPosition = { left: number; top: number; objectId: string };

const TABLE_CONTEXT_COMMANDS: ReadonlyArray<{ command: TableCommand; label: string }> = [
  { command: "insertRowAbove", label: "위에 행 삽입" },
  { command: "insertRowBelow", label: "아래에 행 삽입" },
  { command: "insertColumnLeft", label: "왼쪽에 열 삽입" },
  { command: "insertColumnRight", label: "오른쪽에 열 삽입" },
  { command: "deleteRow", label: "행 삭제" },
  { command: "deleteColumn", label: "열 삭제" },
  { command: "mergeRight", label: "오른쪽 셀과 병합" },
  { command: "mergeDown", label: "아래 셀과 병합" },
  { command: "splitCell", label: "셀 나누기" },
];

const PARAGRAPH_RAW_UNITS_PER_MM = 72 * 200 / 25.4;

function pageSetupForm(page: PageDefinition): PageSetupForm {
  const mm = (value: number) => Math.round(value * 10) / 10;
  return {
    widthMm: mm(page.width),
    heightMm: mm(page.height),
    marginLeftMm: mm(page.marginLeft),
    marginRightMm: mm(page.marginRight),
    marginTopMm: mm(page.marginTop),
    marginBottomMm: mm(page.marginBottom),
    orientation: page.landscape ? "landscape" : "portrait",
  };
}

function pageSetupUpdates(form: PageSetupForm) {
  return {
    width: form.widthMm,
    height: form.heightMm,
    marginLeft: form.marginLeftMm,
    marginRight: form.marginRightMm,
    marginTop: form.marginTopMm,
    marginBottom: form.marginBottomMm,
    landscape: form.orientation === "landscape",
  };
}

function DocumentPage({
  session,
  pageIndex,
  zoom,
  renderVersion,
  editMode,
  caret,
  imePreedit,
  selectionRectsByPage,
  selectedObject,
  objectPreviewElementRef,
  showRulers,
  onPagePointerDown,
  onPagePointerMove,
  onPagePointerUp,
  onPagePointerCancel,
  onPageContextMenu,
}: {
  session: DocumentSession;
  pageIndex: number;
  zoom: number;
  renderVersion: number;
  editMode: boolean;
  caret: TextPosition | null;
  imePreedit: string;
  selectionRectsByPage: ReadonlyMap<number, SelectionRectangle[]>;
  selectedObject: DocumentObject | null;
  objectPreviewElementRef: MutableRefObject<SVGRectElement | null>;
  showRulers: boolean;
  onPagePointerDown: (pageIndex: number, event: PointerEvent<HTMLDivElement>) => void;
  onPagePointerMove: (pageIndex: number, event: PointerEvent<HTMLDivElement>) => void;
  onPagePointerUp: (pageIndex: number, event: PointerEvent<HTMLDivElement>) => void;
  onPagePointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onPageContextMenu: (pageIndex: number, event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const pendingSvgCommitStartedAt = useRef<number | null>(null);
  const pageInfo = useMemo(() => session.pageInfo(pageIndex), [session, pageIndex, renderVersion]);
  const selectionRects = selectionRectsByPage.get(pageIndex) ?? [];
  const isHanulTextPage = session.engineId === "hanul-text";
  const pageRenderRevision = session.renderRevision?.(pageIndex) ?? renderVersion;
  const hanulPageRender = useMemo(() => {
    if (!isHanulTextPage) return null;
    try {
      const measure = shouldMeasureInitialPage(session, pageIndex);
      const renderStartedAt = performance.now();
      const rendered = session.renderPage(pageIndex);
      const renderMs = performance.now() - renderStartedAt;
      const sanitizeStartedAt = performance.now();
      const safeSvg = sanitizeRenderedSvg(DOMPurify, rendered);
      const sanitizeMs = performance.now() - sanitizeStartedAt;
      if (import.meta.env.DEV) {
        const metrics = session.performanceMetrics?.();
        reportAppPerformance("page-svg-render", {
          page: pageIndex + 1,
          modelMutationMs: Number((metrics?.modelMutationMs ?? 0).toFixed(2)),
          incrementalLayoutMs: Number((metrics?.incrementalLayoutMs ?? 0).toFixed(2)),
          svgMs: Number((metrics?.renderedPageMs ?? renderMs).toFixed(2)),
          sanitizeMs: Number(sanitizeMs.toFixed(2)),
          invalidatedParagraphs: metrics?.invalidatedParagraphs ?? 0,
          invalidatedPages: metrics?.invalidatedPages ?? 0,
        });
        pendingSvgCommitStartedAt.current = performance.now();
      }
      if (measure) {
        reportAppPerformance("first-page-svg", { page: pageIndex + 1, sourceSvgCharacters: rendered.length, renderMs: Number(renderMs.toFixed(1)), sanitizeMs: Number(sanitizeMs.toFixed(1)) });
      }
      return { svg: safeSvg, error: "" };
    } catch (cause) {
      return { svg: "", error: cause instanceof Error ? cause.message : "페이지를 그리지 못했습니다." };
    }
  }, [session, pageIndex, pageRenderRevision, isHanulTextPage]);
  const displaySvg = isHanulTextPage ? hanulPageRender?.svg ?? "" : svg;
  const displayError = isHanulTextPage ? hanulPageRender?.error ?? "" : error;

  useEffect(() => {
    if (isHanulTextPage) return;
    let active = true;
    setSvg("");
    setError("");

    try {
      const measure = shouldMeasureInitialPage(session, pageIndex);
      const renderStartedAt = performance.now();
      const rendered = session.renderPage(pageIndex);
      const renderMs = performance.now() - renderStartedAt;
      const sanitizeStartedAt = performance.now();
      const safeSvg = sanitizeRenderedSvg(DOMPurify, rendered);
      const sanitizeMs = performance.now() - sanitizeStartedAt;
      if (active) {
        if (import.meta.env.DEV) {
          const metrics = session.performanceMetrics?.();
          reportAppPerformance("page-svg-render", {
            page: pageIndex + 1,
            modelMutationMs: Number((metrics?.modelMutationMs ?? 0).toFixed(2)),
            incrementalLayoutMs: Number((metrics?.incrementalLayoutMs ?? 0).toFixed(2)),
            svgMs: Number((metrics?.renderedPageMs ?? renderMs).toFixed(2)),
            sanitizeMs: Number(sanitizeMs.toFixed(2)),
            invalidatedParagraphs: metrics?.invalidatedParagraphs ?? 0,
            invalidatedPages: metrics?.invalidatedPages ?? 0,
          });
          pendingSvgCommitStartedAt.current = performance.now();
        }
        if (measure) {
          reportAppPerformance("first-page-svg", {
            page: pageIndex + 1,
            sourceSvgCharacters: rendered.length,
            renderMs: Number(renderMs.toFixed(1)),
            sanitizeMs: Number(sanitizeMs.toFixed(1)),
          });
        }
        setSvg(safeSvg);
      }
    } catch (cause) {
      if (active) {
        setError(cause instanceof Error ? cause.message : "페이지를 그리지 못했습니다.");
      }
    }

    return () => {
      active = false;
    };
  }, [session, pageIndex, renderVersion, isHanulTextPage]);

  useLayoutEffect(() => {
    const startedAt = pendingSvgCommitStartedAt.current;
    if (displaySvg && startedAt !== null) {
      reportAppPerformance("page-react-commit", {
        page: pageIndex + 1,
        renderToCommitMs: Number((performance.now() - startedAt).toFixed(2)),
      });
      pendingSvgCommitStartedAt.current = null;
    }
  }, [pageIndex, displaySvg, pageRenderRevision]);

  const pageSvgViewBox = useMemo(() => {
    const match = displaySvg.match(/\bviewBox=["']([^"']+)["']/i);
    const values = match?.[1].trim().split(/[\s,]+/).map(Number);
    return values?.length === 4 && values.every(Number.isFinite)
      ? values.join(" ")
      : `0 0 ${pageInfo.width} ${pageInfo.height}`;
  }, [displaySvg, pageInfo.width, pageInfo.height]);
  const cursorOnPage = editMode && caret?.cursorRect.pageIndex === pageIndex ? caret.cursorRect : null;
  const imePreeditOnPage = imePreedit && cursorOnPage ? imePreedit : "";
  const selectedObjectOnPage = selectedObject?.pageIndex === pageIndex ? selectedObject : null;
  const hasOverlay = selectionRects.length > 0 || cursorOnPage !== null || selectedObjectOnPage !== null || Boolean(imePreeditOnPage);

  return (
    <div className="page-slot" style={{ "--zoom": String(zoom), "--page-width": `${pageInfo.width}px`, "--page-height": `${pageInfo.height}px` } as CSSProperties}>
      {showRulers && <>
        <div className="horizontal-ruler" aria-hidden="true">
          {Array.from({ length: 20 }, (_, index) => <span key={index}>{index}</span>)}
        </div>
        <div className="vertical-ruler" aria-hidden="true">
          {Array.from({ length: 29 }, (_, index) => <span key={index}>{index}</span>)}
        </div>
      </>}
      <article
        className={`document-page${editMode ? " is-editing" : ""}`}
        aria-label={`${pageIndex + 1}쪽`}
        data-page-index={pageIndex}
        style={{ "--zoom": String(zoom), "--page-width": `${pageInfo.width}px`, "--page-height": `${pageInfo.height}px` } as CSSProperties}
      >
        {displayError ? (
          <div className="page-error">
            <Icon name="file" size={24} />
            <strong>이 페이지를 표시할 수 없습니다</strong>
            <span>{displayError}</span>
          </div>
        ) : displaySvg ? (
          <div
            className={`page-svg${editMode ? " can-edit" : ""}`}
            onPointerDown={(event) => onPagePointerDown(pageIndex, event)}
            onPointerMove={(event) => onPagePointerMove(pageIndex, event)}
            onPointerUp={(event) => onPagePointerUp(pageIndex, event)}
            onPointerCancel={onPagePointerCancel}
            onContextMenu={(event) => onPageContextMenu(pageIndex, event)}
          >
            <div className="page-render-layer" dangerouslySetInnerHTML={{ __html: displaySvg }} />
            {hasOverlay && <svg className="page-overlays" aria-hidden="true" viewBox={pageSvgViewBox}>
              {selectionRects.map((rect, index) => <rect
                key={`selection-${index}`}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                fill="#7bb8ff"
                fillOpacity="0.42"
              />)}
              {cursorOnPage && [cursorOnPage.x, cursorOnPage.y, cursorOnPage.height].every(Number.isFinite) && <line
                className="hanul-caret"
                x1={cursorOnPage.x}
                y1={cursorOnPage.y}
                x2={cursorOnPage.x}
                y2={cursorOnPage.y + Math.max(cursorOnPage.height, 16)}
                stroke="#315f86"
                strokeWidth={Math.max(1, pageInfo.width / 794)}
              />}
              {imePreeditOnPage && cursorOnPage && <text
                className="ime-preedit"
                x={cursorOnPage.x}
                y={cursorOnPage.y + 16}
                fontFamily="함초롬바탕, sans-serif"
                fontSize="16"
                fill="#161616"
                textDecoration="underline"
              >{imePreeditOnPage}</text>}
              {selectedObjectOnPage && (() => {
                const bounds = selectedObjectOnPage.bounds;
                const handleSize = 10;
                return <>
                  <rect
                    ref={objectPreviewElementRef}
                    x={bounds.x}
                    y={bounds.y}
                    width={bounds.width}
                    height={bounds.height}
                    fill="none"
                    fillOpacity="0"
                    stroke="#2468a2"
                    strokeWidth="1.5"
                    strokeDasharray="4 2"
                  />
                  <rect
                    x={bounds.x + bounds.width - handleSize / 2}
                    y={bounds.y + bounds.height - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    fill="#ffffff"
                    stroke="#2468a2"
                    strokeWidth="1.5"
                  />
                </>;
              })()}
            </svg>}
          </div>
        ) : (
          <div className="page-loading" aria-label="페이지 렌더링 중" />
        )}
      </article>
      <span className="page-number">{pageIndex + 1}</span>
    </div>
  );
}

function PrintPreviewPage({ session, pageIndex }: { session: DocumentSession; pageIndex: number }) {
  try {
    const info = session.pageInfo(pageIndex);
    const widthMm = Math.max(1, info.width * 25.4 / 96);
    const heightMm = Math.max(1, info.height * 25.4 / 96);
    const svg = sanitizeRenderedSvg(DOMPurify, session.renderPage(pageIndex));
    return (
      <article
        className="print-preview-page"
        aria-label={`${info.pageNumber}쪽`}
        data-page-index={pageIndex}
        style={{ "--print-page-width": `${widthMm}mm`, "--print-page-height": `${heightMm}mm` } as CSSProperties}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "페이지를 미리 볼 수 없습니다.";
    return <article className="print-preview-page print-preview-error" aria-label={`${pageIndex + 1}쪽 오류`}>{message}</article>;
  }
}

function App() {
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const reader = useRef<VirtuosoHandle>(null);
  const activeSession = useRef<DocumentSession | null>(null);
  const documentLoads = useRef(new LatestDocumentLoad());
  const documentSaveLock = useRef(new DocumentSaveLock());
  const documentLoadInProgress = useRef(false);
  const documentEditRevision = useRef(0);
  const allowWindowClose = useRef(false);
  const originalPrintTitle = useRef<string | null>(null);
  const imeInputGate = useRef(new ImeInputGate());
  const pointerSelection = useRef<EditorSelection | null>(null);
  const objectPointerDrag = useRef<ObjectPointerDrag | null>(null);
  const objectPreviewElement = useRef<SVGRectElement | null>(null);
  const pointerGestureMetrics = useRef<PointerGestureMetrics | null>(null);
  const pointerMoveFrames = useRef<LatestFrame<PendingPointerSample> | null>(null);
  if (!pointerMoveFrames.current) pointerMoveFrames.current = new LatestFrame();
  const clearObjectDragPreview = () => {
    const element = objectPreviewElement.current;
    if (!element) return;
    if (selectedObject) {
      element.setAttribute("x", String(selectedObject.bounds.x));
      element.setAttribute("y", String(selectedObject.bounds.y));
      element.setAttribute("width", String(selectedObject.bounds.width));
      element.setAttribute("height", String(selectedObject.bounds.height));
    }
    element.setAttribute("fill", "none");
    element.setAttribute("fill-opacity", "0");
  };
  const [session, setSession] = useState<DocumentSession | null>(null);
  const isHanulTextEngine = session?.engineId === "hanul-text";
  const [fileName, setFileName] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileFormat, setFileFormat] = useState<"hwp" | "hwpx" | "">("");
  const [fileSize, setFileSize] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showRulers, setShowRulers] = useState(true);
  const [pageView, setPageView] = useState<"continuous" | "single">("continuous");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [message, setMessage] = useState("");
  const editMode = Boolean(session);
  const [dirty, setDirty] = useState(false);
  const [caret, setCaret] = useState<TextPosition | null>(null);
  const [imePreedit, setImePreedit] = useState("");
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [pendingCharacterFormat, setPendingCharacterFormat] = useState<CharacterFormat>({});
  const [formatDialogTab, setFormatDialogTab] = useState<FormatDialogTab | null>(null);
  const [characterFormatDraft, setCharacterFormatDraft] = useState<CharacterFormatDraft | null>(null);
  const [paragraphFormatDraft, setParagraphFormatDraft] = useState<ParagraphFormatDraft | null>(null);
  const [tableRows, setTableRows] = useState(2);
  const [tableColumns, setTableColumns] = useState(2);
  const [tableDraft, setTableDraft] = useState<TableLayoutInfo | null>(null);
  const [tableDraftUpdates, setTableDraftUpdates] = useState<Partial<TableUpdates>>({});
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [objectEditDraft, setObjectEditDraft] = useState<ObjectEditDraft | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuPosition | null>(null);
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuPosition | null>(null);
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>("편집");
  const [pageSetupDialog, setPageSetupDialog] = useState<PageSetupDialogState | null>(null);
  const [headerFooterDialog, setHeaderFooterDialog] = useState<HeaderFooterDialogState | null>(null);
  const [documentInfoDialog, setDocumentInfoDialog] = useState<DocumentInfoDialogState | null>(null);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printRequest, setPrintRequest] = useState<PrintRequest | null>(null);
  const [printIssue, setPrintIssue] = useState("");
  const [hyperlinkRange, setHyperlinkRange] = useState<EditorSelection | null>(null);
  const [hyperlinkUri, setHyperlinkUri] = useState("");
  const [hyperlinkLabel, setHyperlinkLabel] = useState("");
  const [hyperlinkError, setHyperlinkError] = useState("");
  const [hyperlinkDialogOpen, setHyperlinkDialogOpen] = useState(false);
  const [specialCharacter, setSpecialCharacter] = useState("※");
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1);
  const [renderVersion, setRenderVersion] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingDocumentAction | null>(null);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [saveCandidate, setSaveCandidate] = useState<SaveExportCandidate | null>(null);
  const [saveDestination, setSaveDestination] = useState<string | null>(null);
  const [pdfCandidate, setPdfCandidate] = useState<PdfExportCandidate | null>(null);
  const [recentDocuments, setRecentDocuments] = useState(() => {
    try {
      return readRecentDocuments(window.localStorage);
    } catch {
      return [];
    }
  });

  const documentObjects = useMemo(() => {
    if (!session) return [];
    try {
      const pageIndex = Math.max(0, Math.min(currentPage - 1, session.pageCount - 1));
      return session.listObjects(session.pageInfo(pageIndex).sectionIndex);
    } catch {
      return [];
    }
  }, [session, currentPage, renderVersion]);
  const selectedObject = documentObjects.find((object) => object.id === selectedObjectId) ?? null;
  const selectionRectsByPage = useMemo(() => {
    const byPage = new Map<number, SelectionRectangle[]>();
    if (!session || !selection || compareEditorPositions(selection.anchor, selection.focus) === 0) return byPage;
    try {
      for (const rect of session.selectionRectangles(selection.anchor, selection.focus)) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const pageRects = byPage.get(rect.pageIndex) ?? [];
        pageRects.push(rect);
        byPage.set(rect.pageIndex, pageRects);
      }
    } catch {
      // Keep a valid caret if the current range includes an unsupported control.
    }
    return byPage;
  }, [session, selection]);

  useEffect(() => {
    if (!selectedObject) {
      setObjectEditDraft(null);
      return;
    }
    setObjectEditDraft({
      widthMm: String(Math.round(selectedObject.widthMm * 10) / 10),
      heightMm: String(Math.round(selectedObject.heightMm * 10) / 10),
      offsetXmm: String(Math.round(selectedObject.offsetXmm * 10) / 10),
      offsetYmm: String(Math.round(selectedObject.offsetYmm * 10) / 10),
      textWrap: selectedObject.textWrap,
    });
  }, [selectedObjectId, session, renderVersion]);

  useEffect(() => {
    setSelectedObjectId("");
    objectPointerDrag.current = null;
  }, [session]);

  const rememberRecent = useCallback((path: string, label: string) => {
    if (!path) return;
    try {
      setRecentDocuments(rememberRecentDocument(window.localStorage, { path, label }));
    } catch {
      // Recent paths are optional; storage restrictions must not interrupt document work.
    }
  }, []);

  const forgetRecent = useCallback((path: string) => {
    try {
      setRecentDocuments(forgetRecentDocument(window.localStorage, path));
    } catch {
      setRecentDocuments((documents) => documents.filter((item) => item.path !== path));
    }
  }, []);

  useEffect(
    () => () => {
      documentLoads.current.invalidate();
      activeSession.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    const restorePrintTitle = () => {
      if (originalPrintTitle.current !== null) {
        document.title = originalPrintTitle.current;
        originalPrintTitle.current = null;
      }
      setPrintRequest(null);
    };
    window.addEventListener("afterprint", restorePrintTitle);
    return () => window.removeEventListener("afterprint", restorePrintTitle);
  }, []);

  useEffect(() => {
    if (!printPreviewOpen || !printRequest || !session) return;
    let secondFrame = 0;
    const restorePrintTitle = () => {
      if (originalPrintTitle.current !== null) {
        document.title = originalPrintTitle.current;
        originalPrintTitle.current = null;
      }
      setPrintRequest(null);
    };
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (typeof window.print !== "function") {
          const issue = "이 환경에서는 시스템 인쇄 대화상자를 사용할 수 없습니다.";
          setPrintIssue(issue);
          setMessage(issue);
          setPrintRequest(null);
          return;
        }
        originalPrintTitle.current = document.title;
        document.title = fileName.replace(/\.(hwp|hwpx)$/i, "") || "한울 문서";
        try {
          window.print();
        } catch (cause) {
          restorePrintTitle();
          const issue = cause instanceof Error
            ? `시스템 인쇄를 시작하지 못했습니다. (${cause.message})`
            : "시스템 인쇄를 시작하지 못했습니다.";
          setPrintIssue(issue);
          setMessage(issue);
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [fileName, printPreviewOpen, printRequest, session]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (!active || allowWindowClose.current) return;
      if (documentSaveLock.current.isLocked) {
        event.preventDefault();
        setMessage("저장이 끝날 때까지 창을 닫을 수 없습니다.");
        return;
      }
      if (!dirty) return;
      event.preventDefault();
      setPendingAction({ kind: "exit" });
      setDialogState("unsaved");
    }).then((stopListening) => {
      if (active) unlisten = stopListening;
      else stopListening();
    }).catch((cause: unknown) => {
      if (active) setMessage(cause instanceof Error ? `창 닫기 확인을 준비하지 못했습니다. (${cause.message})` : "창 닫기 확인을 준비하지 못했습니다.");
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [dirty]);

  useLayoutEffect(() => {
    if (!editMode || !caret || !editInput.current) return;
    const place = () => {
      const page = document.querySelector<HTMLElement>(
        `.document-page[data-page-index="${caret.cursorRect.pageIndex}"]`,
      );
      const svg = page?.querySelector("svg");
      if (svg) placeImeInput(editInput.current!, svg, caret);
    };
    const scrollArea = document.querySelector(".page-list");
    place();
    scrollArea?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      scrollArea?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [caret, editMode, renderVersion, zoom]);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  const loadPendingDocument = useCallback(async (pending: PendingDocument) => {
    if (!pending.createNew) {
      const validation = validateDocumentFile(pending.name, pending.size);
      if (!validation.ok) {
        setMessage(validation.message);
        return;
      }
    }

    const loadRevision = documentLoads.current.begin();
    const openStartedAt = performance.now();
    documentLoadInProgress.current = true;
    setIsLoading(true);
    setLoadingStatus(pending.createNew ? "새 문서를 구성하는 중…" : "파일을 읽는 중…");
    setMessage("");
    let nextSession: DocumentSession | null = null;
    try {
      let bytes = new Uint8Array();
      if (pending.createNew) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
        setLoadingStatus("새 문서의 쪽을 구성하는 중…");
        nextSession = await hanulDocumentEngine.createBlank();
      } else {
        const readStartedAt = performance.now();
        bytes = pending.file
          ? new Uint8Array(await pending.file.arrayBuffer())
          : pending.path
            ? await readFile(pending.path)
            : new Uint8Array();
        reportAppPerformance("file-read", {
          bytes: bytes.byteLength,
          durationMs: Number((performance.now() - readStartedAt).toFixed(1)),
        });
        const actualValidation = validateDocumentFile(pending.name, bytes.byteLength);
        if (!actualValidation.ok) throw new Error(actualValidation.message);
        setLoadingStatus("문서 구조와 쪽을 분석하는 중…");
        // RHWP's public WASM constructor is synchronous; yield a paint first so
        // this plain status is visible during parsing and initial pagination.
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
        // The engine adapter moves only positively recognized simple-text
        // documents into Hanul's incremental model. Complex content remains in
        // the RHWP compatibility session without UI-specific engine branching.
        nextSession = await hanulDocumentEngine.open(bytes);
      }
      if (!nextSession) throw new Error("문서 엔진이 편집 세션을 만들지 않았습니다.");
      const loadedSession = nextSession;
      if (!commitLatestDocumentLoad(documentLoads.current, loadRevision, loadedSession, (candidate) => {
        activeSession.current?.dispose();
        activeSession.current = candidate;
      })) {
        nextSession = null;
        return;
      }
      nextSession = null;
      let initialCaret: TextPosition | null = null;
      const hitTestStartedAt = performance.now();
      try {
        initialCaret = loadedSession.hitTest(0, 113, 132);
      } catch {
        // Keep opening readable when the first body position is not editable.
      }
      reportAppPerformance("initial-hit-test", {
        durationMs: Number((performance.now() - hitTestStartedAt).toFixed(1)),
      });
      setSession(loadedSession);
      setFileName(pending.name);
      setFilePath(pending.path ?? "");
      setFileFormat(loadedSession.sourceFormat === "hwpx" ? "hwpx" : "hwp");
      setDocumentInfoDialog(null);
      setPrintPreviewOpen(false);
      setPrintRequest(null);
      if (pending.path) rememberRecent(pending.path, pending.name);
      setFileSize(pending.createNew ? 0 : bytes.byteLength);
      setDirty(false);
      documentEditRevision.current = 0;
      setCaret(initialCaret);
      setImePreedit("");
      setSelection(null);
      setPendingCharacterFormat({});
      pointerSelection.current = null;
      setRenderVersion((value) => value + 1);
      setCurrentPage(1);
      setPageInput("1");
      setZoom(1);
      reader.current?.scrollToIndex({ index: 0, align: "start" });
      if (initialCaret) {
        window.requestAnimationFrame(() => {
          if (activeSession.current === loadedSession) editInput.current?.focus();
        });
      }
      reportAppPerformance("document-session-ready", {
        totalMs: Number((performance.now() - openStartedAt).toFixed(1)),
        bytes: bytes.byteLength,
        pages: loadedSession.pageCount,
      });
    } catch (cause) {
      if (documentLoads.current.isCurrent(loadRevision)) {
        nextSession?.dispose();
        setMessage(
          cause instanceof Error
            ? `문서를 열지 못했습니다. 파일 형식이나 손상 여부를 확인해 주세요. (${cause.message})`
            : "문서를 열지 못했습니다. 파일 형식이나 손상 여부를 확인해 주세요.",
        );
      } else {
        nextSession?.dispose();
      }
    } finally {
      if (documentLoads.current.isCurrent(loadRevision)) {
        documentLoadInProgress.current = false;
        setIsLoading(false);
        setLoadingStatus("");
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  }, [rememberRecent]);

  const openDocument = useCallback(
    async (pending: PendingDocument) => {
      if (documentSaveLock.current.isLocked) {
        setMessage("저장이 끝난 뒤 문서를 열거나 바꿀 수 있습니다.");
        return;
      }
      if (!pending.createNew) {
        const validation = validateDocumentFile(pending.name, pending.size);
        if (!validation.ok) {
          setMessage(validation.message);
          return;
        }
      }
      if (dirty) {
        setPendingAction({ kind: "open", pending });
        setDialogState("unsaved");
        return;
      }
      await loadPendingDocument(pending);
    },
    [dirty, loadPendingDocument],
  );

  const chooseDocument = useCallback(async () => {
    if (documentSaveLock.current.isLocked) {
      setMessage("저장이 끝난 뒤 문서를 열거나 바꿀 수 있습니다.");
      return;
    }
    setMessage("");
    if (!isTauri()) {
      fileInput.current?.click();
      return;
    }
    try {
      const selected = await openDialog({
        title: "한글 문서 열기",
        multiple: false,
        filters: [{ name: "한글 문서", extensions: ["hwp", "hwpx"] }],
      });
      if (typeof selected !== "string") return;
      const info = await stat(selected);
      await openDocument({ name: getBaseName(selected), size: info.size, path: selected });
    } catch (cause) {
      setMessage(cause instanceof Error ? `파일을 열지 못했습니다. (${cause.message})` : "파일을 열지 못했습니다.");
    }
  }, [openDocument]);

  const chooseNewDocument = useCallback(async () => {
    if (documentSaveLock.current.isLocked) {
      setMessage("저장이 끝난 뒤 새 문서를 만들 수 있습니다.");
      return;
    }
    setMessage("");
    await openDocument({ name: "새 문서.hwp", size: 0, createNew: true });
  }, [openDocument]);

  const clearDocument = useCallback(() => {
    documentLoads.current.invalidate();
    documentLoadInProgress.current = false;
    activeSession.current?.dispose();
    activeSession.current = null;
    setSession(null);
    setFileName("");
    setFilePath("");
    setFileFormat("");
    setFileSize(0);
    setDocumentInfoDialog(null);
    setPrintPreviewOpen(false);
    setPrintRequest(null);
    setDirty(false);
    documentEditRevision.current = 0;
    setIsLoading(false);
    setLoadingStatus("");
    setCaret(null);
    setSelection(null);
    setPendingCharacterFormat({});
    setRenderVersion((value) => value + 1);
    setCurrentPage(1);
    setPageInput("1");
    pointerSelection.current = null;
  }, []);

  const exitApp = useCallback(async () => {
    if (!isTauri()) {
      setMessage("앱 종료는 데스크톱 앱에서 사용할 수 있습니다.");
      return;
    }
    try {
      allowWindowClose.current = true;
      await getCurrentWindow().close();
    } catch (cause) {
      allowWindowClose.current = false;
      setMessage(cause instanceof Error ? `앱을 종료하지 못했습니다. (${cause.message})` : "앱을 종료하지 못했습니다.");
    }
  }, []);

  const continuePendingAction = useCallback(async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    setDialogState(null);
    setSaveCandidate(null);
    setSaveDestination(null);
    if (action.kind === "open") await loadPendingDocument(action.pending);
    else if (action.kind === "close") clearDocument();
    else await exitApp();
  }, [clearDocument, exitApp, loadPendingDocument, pendingAction]);

  const requestCloseDocument = useCallback(() => {
    if (documentSaveLock.current.isLocked) {
      setMessage("저장이 끝난 뒤 문서를 닫을 수 있습니다.");
      return;
    }
    if (!session) return;
    if (dirty) {
      setPendingAction({ kind: "close" });
      setDialogState("unsaved");
    } else {
      clearDocument();
    }
  }, [clearDocument, dirty, session]);

  const requestExitApp = useCallback(() => {
    if (documentSaveLock.current.isLocked) {
      setMessage("저장이 끝날 때까지 앱을 종료할 수 없습니다.");
      return;
    }
    if (dirty) {
      setPendingAction({ kind: "exit" });
      setDialogState("unsaved");
    } else {
      void exitApp();
    }
  }, [dirty, exitApp]);

  const saveExport = useCallback(
    async (
      result: ExportResult,
      destinationPath: string | null,
      sourceEngine: Exclude<CompatibilityEngine, "rhwp-inspector">,
      allowLossy: boolean,
      expectedEditRevision: number,
    ) => {
      try {
        let savedPath = "";
        if (isTauri()) {
          if (!destinationPath) throw new Error("저장 경로를 선택하지 않았습니다.");
          const temporaryPath = `${destinationPath}.hanul-${crypto.randomUUID()}.tmp`;
          try {
            await writeFile(temporaryPath, result.bytes);
            const compatibility = await invoke<DocumentCompatibilityReport>("inspect_document_compatibility", {
              documentPath: temporaryPath,
              outputFormat: result.report.outputFormat,
              sourceEngine,
              knownLossCount: result.report.count,
            });
            if (!canSaveWithCompatibility(compatibility, allowLossy)) {
              throw new Error(compatibilityIssueMessage(compatibility, "이 문서 구조는 호환성 검증이 끝나지 않아 저장을 차단했습니다."));
            }
            await invoke("commit_document_save", {
              temporaryPath,
              outputPath: destinationPath,
              outputFormat: result.report.outputFormat,
              sourceEngine,
              knownLossCount: result.report.count,
              allowLossy,
            });
          } finally {
            try {
              await remove(temporaryPath);
            } catch {
              // The staged file may already have been atomically moved into place.
            }
          }
          savedPath = destinationPath;
        } else {
          const blob = new Blob([new Uint8Array(result.bytes)], { type: "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          const baseName = fileName.replace(/\.(hwp|hwpx)$/i, "") || "문서";
          anchor.download = `${baseName}.${result.report.outputFormat}`;
          anchor.click();
          URL.revokeObjectURL(url);
        }
        setFilePath(savedPath || filePath);
        if (savedPath) setFileName(getBaseName(savedPath));
        setFileFormat(result.report.outputFormat);
        if (savedPath) rememberRecent(savedPath, getBaseName(savedPath));
        setFileSize(result.bytes.byteLength);
        setDirty(documentEditRevision.current !== expectedEditRevision);
        setSaveCandidate(null);
        setSaveDestination(null);
        setDialogState(null);
        setMessage("문서를 저장했습니다.");
        return true;
      } catch (cause) {
        setMessage(`저장하지 못했습니다. (${errorDetail(cause, "알 수 없는 오류")})`);
        return false;
      }
    },
    [fileName, filePath, rememberRecent],
  );

  const beginSaveTransaction = useCallback(() => {
    if (documentSaveLock.current.acquire()) {
      setIsSaving(true);
      return true;
    }
    setMessage("이미 저장 작업이 진행 중입니다.");
    return false;
  }, []);

  const endSaveTransaction = useCallback(() => {
    documentSaveLock.current.release();
    setIsSaving(false);
  }, []);

  const saveCurrent = useCallback(async (saveAs = false) => {
    if (!session) return;
    if (documentLoadInProgress.current) {
      setMessage("문서를 여는 동안에는 저장할 수 없습니다.");
      return;
    }
    if (!beginSaveTransaction()) return;
    try {
      const sourceFormat = fileFormat || session.sourceFormat;
      if (sourceFormat !== "hwp" && sourceFormat !== "hwpx") throw new Error("현재 저장할 수 없는 문서 형식입니다.");
      let format: "hwp" | "hwpx" = sourceFormat;
      let destinationPath: string | null = filePath || null;

      if (isTauri() && (saveAs || !destinationPath)) {
        const selected = await saveDialog({
          title: saveAs ? "다른 이름으로 저장" : "한글 문서 저장",
          defaultPath: filePath || fileName || `문서.${format}`,
          filters: [
            { name: "한글 문서 (*.hwp)", extensions: ["hwp"] },
            { name: "한글 XML 문서 (*.hwpx)", extensions: ["hwpx"] },
          ],
        });
        if (!selected) return;
        const extension = /\.([^.\\/]+)$/i.exec(selected)?.[1]?.toLowerCase();
        if (extension && extension !== "hwp" && extension !== "hwpx") {
          setMessage("HWP 또는 HWPX 형식으로만 저장할 수 있습니다.");
          return;
        }
        if (extension === "hwp" || extension === "hwpx") format = extension;
        destinationPath = extension ? selected : `${selected}.${format}`;
      } else if (!isTauri()) {
        destinationPath = null;
      }

      const compatibility = session.compatibilityReport(format);
      if (!canSaveWithCompatibility(compatibility, false)) {
        throw new Error(compatibilityIssueMessage(compatibility, "이 " + format.toUpperCase() + " 문서 구조는 호환성 검증이 끝나지 않아 저장을 차단했습니다."));
      }
      const result = session.exportWithReport(format);
      const exportCompatibility = withSerializerLosses(compatibility, result.report);
      const sourceEngine: Exclude<CompatibilityEngine, "rhwp-inspector"> =
        session.engineId === "hanul-text" ? "hanul-text" : "rhwp-compat";
      if (!canSaveWithCompatibility(exportCompatibility, false)) {
        setSaveCandidate({ result, sourceEngine, editRevision: documentEditRevision.current });
        setSaveDestination(destinationPath);
        setDialogState("loss");
        return;
      }
      const editRevision = documentEditRevision.current;
      const saved = await saveExport(result, destinationPath, sourceEngine, false, editRevision);
      if (saved && pendingAction) {
        if (canContinueAfterSave(editRevision, documentEditRevision.current)) await continuePendingAction();
        else {
          setDialogState("unsaved");
          setMessage("저장하는 동안 새 변경 사항이 생겨 문서를 유지했습니다. 계속하려면 다시 저장하거나 취소하세요.");
        }
      }
    } catch (cause) {
      setMessage(`저장을 준비하지 못했습니다. (${errorDetail(cause, "알 수 없는 오류")})`);
    } finally {
      endSaveTransaction();
    }
  }, [beginSaveTransaction, continuePendingAction, endSaveTransaction, fileFormat, fileName, filePath, pendingAction, saveExport, session]);

  const confirmLossSave = useCallback(async () => {
    if (!saveCandidate) return;
    if (documentLoadInProgress.current) {
      setMessage("문서를 여는 동안에는 저장할 수 없습니다.");
      return;
    }
    if (!beginSaveTransaction()) return;
    try {
      const saved = await saveExport(saveCandidate.result, saveDestination, saveCandidate.sourceEngine, true, saveCandidate.editRevision);
      if (saved && pendingAction) {
        if (canContinueAfterSave(saveCandidate.editRevision, documentEditRevision.current)) await continuePendingAction();
        else {
          setDialogState("unsaved");
          setMessage("저장하는 동안 새 변경 사항이 생겨 문서를 유지했습니다. 계속하려면 다시 저장하거나 취소하세요.");
        }
      }
    } finally {
      endSaveTransaction();
    }
  }, [beginSaveTransaction, continuePendingAction, endSaveTransaction, pendingAction, saveCandidate, saveDestination, saveExport]);

  const writePdfExport = useCallback(async ({ result, outputPath }: PdfExportCandidate) => {
    try {
      const pageCount = await invoke<number>("export_pdf", {
        documentBytes: Array.from(result.bytes),
        outputPath,
      });
      setMessage(`${pageCount}쪽 PDF 파일을 저장했습니다.`);
    } catch (cause) {
      setMessage(`PDF를 내보내지 못했습니다. (${errorDetail(cause, "알 수 없는 오류")})`);
    } finally {
      setPdfCandidate(null);
      setDialogState(null);
    }
  }, []);

  const exportPdf = useCallback(async () => {
    if (!session) return;
    if (!isTauri()) {
      setMessage("PDF 파일 내보내기는 Windows/Linux 데스크톱 앱에서 사용할 수 있습니다.");
      return;
    }
    try {
      const baseName = (fileName || "문서").replace(/\.(hwp|hwpx)$/i, "") || "문서";
      const selected = await saveDialog({
        title: "PDF로 내보내기",
        defaultPath: `${baseName}.pdf`,
        filters: [{ name: "PDF 문서 (*.pdf)", extensions: ["pdf"] }],
      });
      if (!selected) return;
      const extension = /\.([^.\\/]+)$/i.exec(selected)?.[1]?.toLowerCase();
      if (extension && extension !== "pdf") {
        setMessage("PDF 내보내기 경로에는 .pdf 파일을 선택해 주세요.");
        return;
      }
      const outputPath = extension ? selected : `${selected}.pdf`;
      const format = fileFormat || session.sourceFormat;
      if (format !== "hwp" && format !== "hwpx") throw new Error("현재 문서 형식은 PDF 내보내기를 지원하지 않습니다.");
      const result = session.exportWithReport(format);
      if (result.report.count > 0) {
        setPdfCandidate({ result, outputPath });
        setDialogState("pdf-loss");
        return;
      }
      await writePdfExport({ result, outputPath });
    } catch (cause) {
      setMessage(`PDF 내보내기를 준비하지 못했습니다. (${errorDetail(cause, "알 수 없는 오류")})`);
    }
  }, [fileFormat, fileName, session, writePdfExport]);

  const confirmPdfLossExport = useCallback(async () => {
    if (!pdfCandidate) return;
    await writePdfExport(pdfCandidate);
  }, [pdfCandidate, writePdfExport]);

  const discardPendingAction = useCallback(async () => {
    await continuePendingAction();
  }, [continuePendingAction]);

  const cancelDialog = useCallback(() => {
    setDialogState(null);
    setPendingAction(null);
    setSaveCandidate(null);
    setSaveDestination(null);
    setPdfCandidate(null);
  }, []);

  const resolvePendingFileAction = useCallback((choice: "save" | "discard" | "cancel") => {
    const resolution = resolveUnsavedChoice(pendingAction, choice);
    if (resolution.kind === "cancel") {
      cancelDialog();
    } else if (resolution.kind === "continue-without-saving") {
      void discardPendingAction();
    } else {
      // `saveCurrent` resumes the exact pending action only after the save
      // pipeline has completed successfully. A cancelled/failed save keeps
      // the current document and confirmation open.
      void saveCurrent();
    }
  }, [cancelDialog, discardPendingAction, pendingAction, saveCurrent]);

  const openRecentDocument = useCallback(async (path: string) => {
    try {
      const info = await stat(path);
      await openDocument({ name: getBaseName(path), size: info.size, path });
    } catch (cause) {
      forgetRecent(path);
      setMessage(cause instanceof Error ? `최근 문서를 열 수 없습니다. 목록에서 제거했습니다. (${cause.message})` : "최근 문서를 열 수 없습니다. 목록에서 제거했습니다.");
    }
  }, [forgetRecent, openDocument]);

  const fileMenuItems = useMemo(() => createFileMenuItems(
    recentDocuments,
    { hasDocument: Boolean(session), canEditPage: Boolean(session && caret), canExit: isTauri(), canExportPdf: isTauri(), isSaving },
  ), [isSaving, recentDocuments, session, caret]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) void openDocument({ name: file.name, size: file.size, file });
  };

  const setCaretPosition = (position: TextPosition) => {
    setCaret(position);
    setCurrentPage(position.cursorRect.pageIndex + 1);
    setPageInput(String(position.cursorRect.pageIndex + 1));
  };

  useEffect(() => () => {
    pointerMoveFrames.current?.cancelPending();
    objectPointerDrag.current = null;
    pointerSelection.current = null;
    clearObjectDragPreview();
  }, []);

  const documentPointFromPointer = (
    pageIndex: number,
    event: Pick<PointerEvent<HTMLDivElement>, "clientX" | "clientY" | "currentTarget">,
  ) => {
    const svg = event.currentTarget.querySelector("svg");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    if (rect.width <= 0 || rect.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return null;
    return {
      pageIndex,
      x: viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.height,
    };
  };

  const hitPositionFromPointer = (
    pageIndex: number,
    event: Pick<PointerEvent<HTMLDivElement>, "clientX" | "clientY" | "currentTarget">,
  ) => {
    if (!session) return null;
    const point = documentPointFromPointer(pageIndex, event);
    return point ? session.hitTest(pageIndex, point.x, point.y) : null;
  };

  const handlePageContextMenu = (pageIndex: number, event: ReactMouseEvent<HTMLDivElement>) => {
    if (!session) return;
    try {
      const point = documentPointFromPointer(pageIndex, event);
      const object = point ? session.hitTestObject(pageIndex, point.x, point.y) : null;
      if (object) {
        event.preventDefault();
        setSelectedObjectId(object.id);
        setCurrentPage(pageIndex + 1);
        setPageInput(String(pageIndex + 1));
        setTableContextMenu(null);
        setObjectContextMenu({
          left: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
          top: Math.max(8, Math.min(event.clientY, window.innerHeight - 120)),
          objectId: object.id,
        });
        return;
      }
      const position = hitPositionFromPointer(pageIndex, event);
      if (!position?.cellPath) {
        setTableContextMenu(null);
        setObjectContextMenu(null);
        return;
      }
      event.preventDefault();
      setObjectContextMenu(null);
      setCaretPosition(position);
      setSelection(null);
      setTableContextMenu({
        left: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
        top: Math.max(8, Math.min(event.clientY, window.innerHeight - 350)),
      });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "표 위치를 확인하지 못했습니다.");
    }
  };

  const processPointerSample = (sample: PendingPointerSample, isAnimationFrame = true) => {
    const metrics = pointerGestureMetrics.current;
    if (isAnimationFrame && metrics) {
      const now = performance.now();
      metrics.frames += 1;
      if (metrics.lastFrameAt !== null) metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, now - metrics.lastFrameAt);
      metrics.lastFrameAt = now;
    }

    const drag = objectPointerDrag.current;
    if (drag) {
      const bounds = previewObjectDrag(
        drag.object,
        { x: drag.startX, y: drag.startY },
        { x: sample.x, y: sample.y },
        drag.resize,
      );
      const element = objectPreviewElement.current;
      if (element) {
        element.setAttribute("x", String(bounds.x));
        element.setAttribute("y", String(bounds.y));
        element.setAttribute("width", String(bounds.width));
        element.setAttribute("height", String(bounds.height));
        element.setAttribute("fill", "#dce8f3");
        element.setAttribute("fill-opacity", "0.24");
      }
      return;
    }

    const active = pointerSelection.current;
    const currentSession = activeSession.current;
    if (!currentSession || !active) return;
    try {
      const focus = currentSession.hitTest(sample.pageIndex, sample.x, sample.y);
      const next = { anchor: active.anchor, focus };
      if (!sameEditorScope(next.anchor, next.focus)) return;
      pointerSelection.current = next;
      setSelection(next);
      setCaretPosition(focus);
    } catch {
      // 드래그가 본문 바깥을 지나가면 마지막 유효 위치를 유지한다.
    }
  };

  const reportPointerGesture = (modelCommitMs = 0) => {
    const metrics = pointerGestureMetrics.current;
    if (metrics?.rawMoves) {
      reportAppPerformance("pointer-gesture", {
        kind: metrics.kind,
        rawMoves: metrics.rawMoves,
        processedFrames: metrics.frames,
        durationMs: Number((performance.now() - metrics.startedAt).toFixed(1)),
        maxFrameGapMs: Number(metrics.maxFrameGapMs.toFixed(1)),
        modelCommitMs: Number(modelCommitMs.toFixed(1)),
      });
    }
    pointerGestureMetrics.current = null;
  };

  const handlePagePointerDown = (pageIndex: number, event: PointerEvent<HTMLDivElement>) => {
    if (!session) return;
    event.preventDefault();
    pointerMoveFrames.current?.cancelPending();
    pointerGestureMetrics.current = null;
    clearObjectDragPreview();
    setObjectContextMenu(null);
    try {
      const point = documentPointFromPointer(pageIndex, event);
      let resizeTarget: DocumentObject | null = null;
      if (point) {
        const svg = event.currentTarget.querySelector("svg");
        const rect = svg?.getBoundingClientRect();
        const viewBox = svg?.viewBox.baseVal;
        const tolerance = rect && viewBox && rect.width > 0
          ? Math.max(5, 10 * viewBox.width / rect.width)
          : 10;
        const sectionIndex = session.pageInfo(pageIndex).sectionIndex;
        resizeTarget = session.listObjects(sectionIndex).find((candidate) => {
          if (candidate.id !== selectedObjectId || candidate.pageIndex !== pageIndex) return false;
          const bounds = candidate.bounds;
          return point.x >= bounds.x + bounds.width - tolerance
            && point.x <= bounds.x + bounds.width + tolerance
            && point.y >= bounds.y + bounds.height - tolerance
            && point.y <= bounds.y + bounds.height + tolerance;
        }) ?? null;
      }
      const object = resizeTarget ?? (point ? session.hitTestObject(pageIndex, point.x, point.y) : null);
      if (point && object) {
        if (object.kind === "textBox" && selectedObjectId === object.id && !resizeTarget) {
          const textPosition = session.hitTest(pageIndex, point.x, point.y);
          if (textPosition.cellPath?.[0]?.controlIndex === object.controlIndex) {
            const next = { anchor: textPosition, focus: textPosition };
            pointerSelection.current = next;
            pointerGestureMetrics.current = {
              kind: "text-box-selection", startedAt: performance.now(), rawMoves: 0, frames: 0, lastFrameAt: null, maxFrameGapMs: 0,
            };
            setSelection(next);
            setCaretPosition(textPosition);
            setPendingCharacterFormat({});
            session.clearTypingFormat();
            event.currentTarget.setPointerCapture(event.pointerId);
            editInput.current?.focus();
            return;
          }
        }
        setSelectedObjectId(object.id);
        setCurrentPage(pageIndex + 1);
        setPageInput(String(pageIndex + 1));
        setSelection(null);
        pointerSelection.current = null;
        objectPointerDrag.current = {
          object,
          pageIndex,
          startX: point.x,
          startY: point.y,
          resize: resizeTarget?.id === object.id,
        };
        pointerGestureMetrics.current = {
          kind: "object-drag",
          startedAt: performance.now(),
          rawMoves: 0,
          frames: 0,
          lastFrameAt: null,
          maxFrameGapMs: 0,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        editInput.current?.focus();
        return;
      }
      setSelectedObjectId("");
      const position = hitPositionFromPointer(pageIndex, event);
      if (!position) return;
      const next = { anchor: position, focus: position };
      pointerSelection.current = next;
      pointerGestureMetrics.current = {
        kind: position.cellPath?.length ? "table-selection" : "text-selection",
        startedAt: performance.now(),
        rawMoves: 0,
        frames: 0,
        lastFrameAt: null,
        maxFrameGapMs: 0,
      };
      setSelection(next);
      setPendingCharacterFormat({});
      session.clearTypingFormat();
      setCaretPosition(position);
      event.currentTarget.setPointerCapture(event.pointerId);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "이 위치에는 입력할 수 없습니다.");
    }
  };

  const handlePagePointerMove = (pageIndex: number, event: PointerEvent<HTMLDivElement>) => {
    const drag = objectPointerDrag.current;
    if (!drag && !pointerSelection.current) return;
    const point = documentPointFromPointer(pageIndex, event);
    if (!point) return;
    if (pointerGestureMetrics.current) pointerGestureMetrics.current.rawMoves += 1;
    pointerMoveFrames.current?.enqueue(point, processPointerSample);
  };

  const handlePagePointerUp = (pageIndex: number, event: PointerEvent<HTMLDivElement>) => {
    pointerMoveFrames.current?.cancelPending();
    const drag = objectPointerDrag.current;
    let modelCommitMs = 0;
    if (drag && session) {
      objectPointerDrag.current = null;
      clearObjectDragPreview();
      try {
        const point = documentPointFromPointer(pageIndex, event);
        if (point) {
          const dxMm = (point.x - drag.startX) * 25.4 / 96;
          const dyMm = (point.y - drag.startY) * 25.4 / 96;
          const bounds = previewObjectDrag(drag.object, { x: drag.startX, y: drag.startY }, point, drag.resize);
          const updates = drag.resize
            ? { widthMm: Math.max(1, bounds.width * 25.4 / 96), heightMm: Math.max(1, bounds.height * 25.4 / 96) }
            : { offsetXmm: drag.object.offsetXmm + dxMm, offsetYmm: drag.object.offsetYmm + dyMm };
          if (dxMm || dyMm) {
            const commitStartedAt = performance.now();
            const position = session.updateObject(drag.object, updates);
            modelCommitMs = performance.now() - commitStartedAt;
            updateAfterEdit(position);
          }
        }
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "문서 개체를 이동하거나 크기를 바꾸지 못했습니다.");
      }
    } else if (pointerSelection.current) {
      const point = documentPointFromPointer(pageIndex, event);
      if (point) processPointerSample(point, false);
    }
    pointerSelection.current = null;
    reportPointerGesture(modelCommitMs);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePagePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    pointerMoveFrames.current?.cancelPending();
    pointerSelection.current = null;
    objectPointerDrag.current = null;
    pointerGestureMetrics.current = null;
    clearObjectDragPreview();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const updateAfterEdit = (position: TextPosition) => {
    documentEditRevision.current += 1;
    const engineMetrics = session?.performanceMetrics?.();
    if (engineMetrics) {
      reportAppPerformance("document-edit-model-layout", {
        modelMutationMs: Number(engineMetrics.modelMutationMs.toFixed(2)),
        incrementalLayoutMs: Number(engineMetrics.incrementalLayoutMs.toFixed(2)),
        invalidatedParagraphs: engineMetrics.invalidatedParagraphs,
        invalidatedPages: engineMetrics.invalidatedPages,
      });
    }
    setCaretPosition(position);
    setSelection(null);
    pointerSelection.current = null;
    setDirty(true);
    setRenderVersion((value) => value + 1);
  };

  const insertText = (text: string) => {
    if (!session || !caret || !text) return;
    try {
      const start = isRangeSelection(selection) ? selection!.anchor : caret;
      const end = isRangeSelection(selection) ? selection!.focus : caret;
      updateAfterEdit(session.replaceRange(start, end, text));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "입력한 내용을 반영하지 못했습니다.");
    }
  };

  const deleteText = (direction: "backward" | "forward") => {
    if (!session || !caret) return;
    try {
      const position = isRangeSelection(selection)
        ? session.deleteRange(selection!.anchor, selection!.focus)
        : session.deleteText(caret, direction);
      if (position !== caret) updateAfterEdit(position);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "문자를 삭제하지 못했습니다.");
    }
  };

  const applyCharacterFormat = (format: CharacterFormat) => {
    if (!session || !caret) return;
    try {
      const start = isRangeSelection(selection) ? selection!.anchor : caret;
      const end = isRangeSelection(selection) ? selection!.focus : caret;
      const position = session.applyCharacterFormat(start, end, format);
      setPendingCharacterFormat((value) => ({ ...value, ...format }));
      if (isRangeSelection(selection)) updateAfterEdit(position);
      else setCaretPosition(position);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "글자 서식을 바꾸지 못했습니다.");
    }
  };

  const applyAlignment = (alignment: "left" | "center" | "right" | "justify") => {
    if (!session || !caret) return;
    try {
      updateAfterEdit(session.applyParagraphAlignment(caret, alignment));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "문단 정렬을 바꾸지 못했습니다.");
    }
  };

  const applyParagraphFormat = (format: ParagraphFormat) => {
    if (!session || !caret) return;
    try {
      updateAfterEdit(session.applyParagraphFormat(caret, format));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "문단 서식을 바꾸지 못했습니다.");
    }
  };

  const applySelectedStyle = (styleId: number) => {
    if (!session || !caret) return;
    try {
      updateAfterEdit(session.applyStyle(caret, styleId));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "스타일을 적용하지 못했습니다.");
    }
  };

  const openPageSetup = () => {
    if (!session || !caret) return;
    try {
      setPageSetupDialog({ position: caret, form: pageSetupForm(session.pageDefinition(caret.sectionIndex)) });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "용지 설정을 읽지 못했습니다.");
    }
  };

  const openDocumentInformation = useCallback(() => {
    if (!session) return;
    try {
      setDocumentInfoDialog({
        fileName: fileName || "새 문서",
        filePath,
        fileFormat: fileFormat || session.sourceFormat,
        fileSize,
        info: session.documentInfo(),
      });
    } catch (cause) {
      setMessage(cause instanceof Error ? `문서 정보를 읽지 못했습니다. (${cause.message})` : "문서 정보를 읽지 못했습니다.");
    }
  }, [fileFormat, fileName, filePath, fileSize, session]);

  const preparePrintRequest = useCallback((request: PrintRequest) => {
    if (!session) return;
    try {
      const pages = Array.from({ length: session.pageCount }, (_, pageIndex) => {
        const info = session.pageInfo(pageIndex);
        if (!(info.width > 0 && info.height > 0)) throw new Error(`${info.pageNumber}쪽 크기가 올바르지 않습니다.`);
        const svg = sanitizeRenderedSvg(DOMPurify, session.renderPage(pageIndex));
        if (!/<svg(?:\s|>)/i.test(svg)) throw new Error(`${info.pageNumber}쪽을 출력용으로 렌더링하지 못했습니다.`);
        return info;
      });
      const firstPage = pages[0];
      const mixedPageSizes = Boolean(firstPage && pages.some((page) =>
        Math.abs(page.width - firstPage.width) > 1 || Math.abs(page.height - firstPage.height) > 1,
      ));
      if (mixedPageSizes) {
        setPrintIssue("쪽마다 용지 크기가 다른 문서는 현재 시스템 인쇄 경로에서 안전하게 출력할 수 없습니다. 문서 손실을 막기 위해 인쇄를 중단했습니다.");
        setPrintRequest(null);
        return;
      }
      setPrintIssue("");
      setPrintRequest(request);
    } catch (cause) {
      const issue = cause instanceof Error
        ? `출력 페이지를 준비하지 못했습니다. (${cause.message})`
        : "출력 페이지를 준비하지 못했습니다.";
      setPrintIssue(issue);
      setPrintRequest(null);
    }
  }, [session]);

  const openPrintPreview = useCallback((request: PrintRequest | null = null) => {
    if (!session) return;
    setMessage("");
    setPrintPreviewOpen(true);
    setPrintIssue("");
    setPrintRequest(null);
    if (request) preparePrintRequest(request);
    else {
      try {
        for (let pageIndex = 0; pageIndex < session.pageCount; pageIndex += 1) {
          session.pageInfo(pageIndex);
          const svg = sanitizeRenderedSvg(DOMPurify, session.renderPage(pageIndex));
          if (!/<svg(?:\s|>)/i.test(svg)) throw new Error(`${pageIndex + 1}쪽을 표시할 수 없습니다.`);
        }
      } catch (cause) {
        setPrintIssue(cause instanceof Error ? `미리보기를 준비하지 못했습니다. (${cause.message})` : "미리보기를 준비하지 못했습니다.");
      }
    }
  }, [preparePrintRequest, session]);

  const runFileCommand = useCallback((command: FileMenuCommand, argument?: string) => {
    if (command === "new-document") void chooseNewDocument();
    else if (command === "open-document") void chooseDocument();
    else if (command === "save-document") void saveCurrent();
    else if (command === "save-as") void saveCurrent(true);
    else if (command === "export-pdf") void exportPdf();
    else if (command === "document-info") openDocumentInformation();
    else if (command === "page-setup") openPageSetup();
    else if (command === "print-preview") openPrintPreview();
    else if (command === "print") openPrintPreview("print");
    else if (command === "close-document") requestCloseDocument();
    else if (command === "exit-app") requestExitApp();
    else if (command === "open-recent" && argument) void openRecentDocument(argument);
  }, [chooseDocument, chooseNewDocument, exportPdf, openDocumentInformation, openPageSetup, openPrintPreview, openRecentDocument, requestCloseDocument, requestExitApp, saveCurrent]);

  const commitPageSetup = () => {
    if (!session || !pageSetupDialog) return;
    try {
      const next = pageSetupUpdates(pageSetupDialog.form);
      updateAfterEdit(session.setPageDefinition(pageSetupDialog.position, next));
      setPageSetupDialog(null);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "용지 설정을 적용하지 못했습니다.");
    }
  };

  const updatePageOrientation = (orientation: PageSetupForm["orientation"]) => {
    setPageSetupDialog((current) => {
      if (!current || current.form.orientation === orientation) return current;
      return {
        ...current,
        form: {
          ...current.form,
          orientation,
          widthMm: current.form.heightMm,
          heightMm: current.form.widthMm,
        },
      };
    });
  };

  const openHyperlinkDialog = () => {
    if (!session || !isRangeSelection(selection)) {
      setMessage("하이퍼링크를 적용할 글자를 먼저 선택하세요.");
      return;
    }
    try {
      const label = session.selectedText(selection!.anchor, selection!.focus);
      if (!label || /[\r\n]/.test(label)) {
        setMessage("하이퍼링크는 한 문단 안의 텍스트 선택에만 적용할 수 있습니다.");
        return;
      }
      setHyperlinkRange({ anchor: selection!.anchor, focus: selection!.focus });
      setHyperlinkLabel(label);
      setHyperlinkUri("");
      setHyperlinkError("");
      setHyperlinkDialogOpen(true);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "선택한 글자를 읽지 못했습니다.");
    }
  };

  const commitHyperlink = () => {
    if (!session || !hyperlinkRange) return;
    try {
      const candidate = hyperlinkUri.trim();
      const normalized = /^[a-z][a-z\d+.-]*:/i.test(candidate) ? candidate : `https://${candidate}`;
      const parsed = new URL(normalized);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
        throw new Error("http, https, mailto 주소만 연결할 수 있습니다.");
      }
      updateAfterEdit(session.setHyperlink(hyperlinkRange.anchor, hyperlinkRange.focus, normalized));
      setHyperlinkDialogOpen(false);
      setHyperlinkRange(null);
      setHyperlinkError("");
      editInput.current?.focus();
    } catch (cause) {
      setHyperlinkError(cause instanceof Error ? cause.message : "하이퍼링크를 적용하지 못했습니다.");
    }
  };

  const insertSpecialCharacter = () => {
    if (!session || !caret) return;
    insertText(specialCharacter);
    editInput.current?.focus();
  };

  const insertPageNumber = () => {
    if (!session || !caret || isRangeSelection(selection)) return;
    try {
      updateAfterEdit(session.insertAutoNumber(caret, "page"));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "쪽 번호를 넣지 못했습니다.");
    }
  };

  const openHeaderFooterDialog = (kind: "header" | "footer") => {
    if (!session || !caret || isRangeSelection(selection)) return;
    try {
      const scope: HeaderFooterScope = "bothPages";
      const info = session.headerFooterInfo(caret, kind, scope);
      setHeaderFooterDialog({ kind, scope, text: info.text, exists: info.exists });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "머리말·꼬리말 상태를 읽지 못했습니다.");
    }
  };

  const changeHeaderFooterScope = (scope: HeaderFooterScope) => {
    if (!session || !caret || !headerFooterDialog) return;
    try {
      const info = session.headerFooterInfo(caret, headerFooterDialog.kind, scope);
      setHeaderFooterDialog((current) => current ? { ...current, scope, text: info.text, exists: info.exists } : current);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "머리말·꼬리말 적용 범위를 확인하지 못했습니다.");
    }
  };

  const insertHeaderFooter = () => {
    if (!session || !caret || !headerFooterDialog) return;
    try {
      updateAfterEdit(session.setHeaderFooterText(caret, headerFooterDialog.kind, headerFooterDialog.scope, headerFooterDialog.text));
      setHeaderFooterDialog(null);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "머리말·꼬리말을 저장하지 못했습니다.");
    }
  };

  const insertHeaderFooterField = (field: HeaderFooterFieldKind) => {
    if (!session || !caret || !headerFooterDialog) return;
    try {
      updateAfterEdit(session.insertHeaderFooterField(caret, headerFooterDialog.kind, headerFooterDialog.scope, field));
      setHeaderFooterDialog(null);
      setMessage("쪽 번호 필드를 넣었습니다. 편집하려면 머리말·꼬리말 대화상자를 다시 여세요.");
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "머리말·꼬리말 필드를 넣지 못했습니다.");
    }
  };

  const deleteHeaderFooter = () => {
    if (!session || !caret || !headerFooterDialog) return;
    try {
      updateAfterEdit(session.deleteHeaderFooter(caret, headerFooterDialog.kind, headerFooterDialog.scope));
      setHeaderFooterDialog(null);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "머리말·꼬리말을 삭제하지 못했습니다.");
    }
  };

  const insertNote = (endnote: boolean) => {
    if (!session || !caret || isRangeSelection(selection)) return;
    try {
      updateAfterEdit(session.insertFootnote(caret, endnote));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : endnote ? "미주를 삽입하지 못했습니다." : "각주를 삽입하지 못했습니다.");
    }
  };

  const onImageFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !session || !caret || isRangeSelection(selection)) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const supported = new Set(["png", "jpg", "jpeg", "gif", "bmp"]);
    if (!supported.has(extension) || file.size > 50 * 1024 * 1024) {
      setMessage("PNG, JPEG, GIF, BMP 그림 파일(50MB 이하)만 넣을 수 있습니다.");
      return;
    }
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const page = session.pageDefinition(caret.sectionIndex);
      const contentWidth = Math.max(1, page.width - page.marginLeft - page.marginRight);
      const targetWidth = bitmap.width * 25.4 / 96;
      const targetHeight = bitmap.height * 25.4 / 96;
      const scale = Math.min(1, contentWidth / targetWidth, (page.height * 0.7) / targetHeight);
      const format = extension === "jpeg" ? "jpg" : extension;
      const previousObjectIds = new Set(session.listObjects(caret.sectionIndex).map((object) => object.id));
      const position = session.insertPicture(
        caret,
        new Uint8Array(await file.arrayBuffer()),
        format,
        bitmap.width,
        bitmap.height,
        targetWidth * scale,
        targetHeight * scale,
      );
      const insertedObject = session.listObjects(caret.sectionIndex).find((object) => !previousObjectIds.has(object.id));
      setSelectedObjectId(insertedObject?.id ?? "");
      updateAfterEdit(position);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "그림을 문서에 넣지 못했습니다.");
    } finally {
      bitmap?.close();
    }
  };

  const insertTable = () => {
    if (!session || !caret || isRangeSelection(selection)) return;
    try {
      const position = session.createTable(caret, tableRows, tableColumns);
      updateAfterEdit(position);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "표를 삽입하지 못했습니다.");
    }
  };

  const insertShape = (kind: "rectangle" | "ellipse" | "textBox") => {
    if (!session || !caret || isRangeSelection(selection)) return;
    try {
      const before = new Set(session.listObjects(caret.sectionIndex).map((object) => object.id));
      const position = session.insertShape(caret, kind, 60, 30);
      const created = session.listObjects(caret.sectionIndex).find((object) => !before.has(object.id));
      setSelectedObjectId(created?.id ?? "");
      updateAfterEdit(position);
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "도형을 삽입하지 못했습니다.");
    }
  };

  const applySelectedObject = () => {
    if (!session || !selectedObject || !objectEditDraft) return;
    const values = [objectEditDraft.widthMm, objectEditDraft.heightMm, objectEditDraft.offsetXmm, objectEditDraft.offsetYmm].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[0] < 1 || values[1] < 1) {
      setMessage("개체의 크기와 위치를 확인하세요. 크기는 1mm 이상이어야 합니다.");
      return;
    }
    try {
      updateAfterEdit(session.updateObject(selectedObject, {
        widthMm: values[0],
        heightMm: values[1],
        offsetXmm: values[2],
        offsetYmm: values[3],
        textWrap: objectEditDraft.textWrap,
      }));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "개체 속성을 적용하지 못했습니다.");
    }
  };

  const deleteSelectedObject = () => {
    if (!session || !selectedObject) return;
    try {
      updateAfterEdit(session.deleteObject(selectedObject));
      setSelectedObjectId("");
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "개체를 삭제하지 못했습니다.");
    }
  };

  const insertPageBreak = useCallback(() => {
    if (!session || !caret) return;
    try {
      const position = isRangeSelection(selection)
        ? session.deleteRange(selection!.anchor, selection!.focus)
        : caret;
      updateAfterEdit(session.insertPageBreak(position));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "쪽 나누기를 삽입하지 못했습니다.");
    }
  }, [session, caret, selection]);

  const runTableCommand = (command: TableCommand) => {
    if (!session || !caret?.cellPath) return;
    setTableContextMenu(null);
    try {
      updateAfterEdit(session.editTable(caret, command));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "표 편집을 적용하지 못했습니다.");
    }
  };

  const applyTableLayout = (updates: TableUpdates) => {
    if (!session || !caret?.cellPath) return;
    try {
      updateAfterEdit(session.updateTable(caret, updates));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "표 속성을 적용하지 못했습니다.");
    }
  };

  const showSearchMatch = (matches: SearchMatch[], index: number) => {
    if (!matches.length) {
      setSearchMatchIndex(-1);
      setSelection(null);
      return;
    }
    const nextIndex = (index + matches.length) % matches.length;
    const match = matches[nextIndex];
    setSearchMatchIndex(nextIndex);
    setSelection({ anchor: match.start, focus: match.end });
    setCaretPosition(match.end);
    moveToPage(match.start.cursorRect.pageIndex + 1);
  };

  const searchDocument = () => {
    if (!session || !searchQuery.trim()) {
      setSearchMatches([]);
      setSearchMatchIndex(-1);
      setSelection(null);
      return;
    }
    try {
      const options: SearchOptions = { includeCells: true, caseSensitive: searchCaseSensitive };
      const matches = session.searchText(searchQuery, options);
      setSearchMatches(matches);
      if (matches.length) showSearchMatch(matches, 0);
      else {
        setSearchMatchIndex(-1);
        setSelection(null);
        setMessage("검색 결과가 없습니다.");
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "문서에서 내용을 찾지 못했습니다.");
    }
  };

  const moveSearchMatch = (direction: -1 | 1) => {
    if (!searchMatches.length) {
      searchDocument();
      return;
    }
    showSearchMatch(searchMatches, searchMatchIndex + direction);
  };

  const replaceCurrentMatch = () => {
    if (!session || searchMatchIndex < 0 || !searchMatches[searchMatchIndex]) return;
    try {
      const position = session.replaceRange(
        searchMatches[searchMatchIndex].start,
        searchMatches[searchMatchIndex].end,
        replaceQuery,
      );
      updateAfterEdit(position);
      setSearchMatches([]);
      setSearchMatchIndex(-1);
      setMessage("찾은 내용을 바꾸었습니다.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "찾은 내용을 바꾸지 못했습니다.");
    }
  };

  const replaceAllMatches = () => {
    if (!session || !searchQuery.trim()) return;
    try {
      const result = session.replaceAllText(searchQuery, replaceQuery, { includeCells: true, caseSensitive: searchCaseSensitive });
      if (result.position) updateAfterEdit(result.position);
      setSearchMatches([]);
      setSearchMatchIndex(-1);
      setMessage(result.count ? `${result.count}곳의 내용을 바꾸었습니다.` : "바꿀 내용을 찾지 못했습니다.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "문서 전체 바꾸기를 완료하지 못했습니다.");
    }
  };

  const copySelection = async (cut = false) => {
    if (!session || !isRangeSelection(selection)) return;
    try {
      const text = session.selectedText(selection!.anchor, selection!.focus);
      await navigator.clipboard.writeText(text);
      if (cut) updateAfterEdit(session.deleteRange(selection!.anchor, selection!.focus));
    } catch (cause) {
      setMessage(cause instanceof Error ? `클립보드 작업을 완료하지 못했습니다. (${cause.message})` : "클립보드 작업을 완료하지 못했습니다.");
    }
  };

  const pasteText = async () => {
    if (!session || !caret) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) insertText(text);
    } catch (cause) {
      setMessage(cause instanceof Error ? `클립보드에서 붙여넣지 못했습니다. (${cause.message})` : "클립보드에서 붙여넣지 못했습니다.");
    }
  };

  const undo = () => {
    if (!session) return;
    try {
      const position = session.undo();
      if (position) {
        documentEditRevision.current += 1;
        setSelection(null);
        setCaretPosition(position);
        setRenderVersion((value) => value + 1);
        setDirty(true);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "실행 취소를 하지 못했습니다.");
    }
  };

  const redo = () => {
    if (!session) return;
    try {
      const position = session.redo();
      if (position) {
        documentEditRevision.current += 1;
        setSelection(null);
        setCaretPosition(position);
        setRenderVersion((value) => value + 1);
        setDirty(true);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "다시 실행하지 못했습니다.");
    }
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && objectContextMenu) {
        event.preventDefault();
        setObjectContextMenu(null);
        editInput.current?.focus();
        return;
      }
      if (event.key === "Escape" && tableContextMenu) {
        event.preventDefault();
        setTableContextMenu(null);
        editInput.current?.focus();
        return;
      }
      if (event.key === "Escape" && formatDialogTab) {
        event.preventDefault();
        setFormatDialogTab(null);
        editInput.current?.focus();
        return;
      }
      if (event.key === "Escape" && headerFooterDialog) {
        event.preventDefault();
        setHeaderFooterDialog(null);
        editInput.current?.focus();
        return;
      }
      if (event.key === "Escape" && documentInfoDialog) {
        event.preventDefault();
        setDocumentInfoDialog(null);
        editInput.current?.focus();
        return;
      }
      if (event.key === "Escape" && printPreviewOpen) {
        event.preventDefault();
        setPrintPreviewOpen(false);
        setPrintRequest(null);
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "o") {
        event.preventDefault();
        runFileCommand("open-document");
      } else if (key === "n") {
        event.preventDefault();
        runFileCommand("new-document");
      } else if (key === "s") {
        event.preventDefault();
        runFileCommand(event.shiftKey ? "save-as" : "save-document");
      } else if (key === "p") {
        event.preventDefault();
        runFileCommand("print");
      } else if (key === "enter") {
        event.preventDefault();
        insertPageBreak();
      } else if (key === "f" || key === "h") {
        event.preventDefault();
        setReplaceMode(key === "h");
        setSearchOpen(true);
      } else if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      } else if (key === "c") {
        if (isRangeSelection(selection)) {
          event.preventDefault();
          void copySelection(false);
        }
      } else if (key === "x") {
        if (isRangeSelection(selection)) {
          event.preventDefault();
          void copySelection(true);
        }
      } else if (key === "v") {
        if (session && caret) {
          event.preventDefault();
          void pasteText();
        }
      } else if (key === "b" || key === "i" || key === "u") {
        if (session && caret) {
          event.preventDefault();
          try {
            const properties = session.characterProperties(caret);
            const formatKey = key === "b" ? "bold" : key === "i" ? "italic" : "underline";
            const current = pendingCharacterFormat[formatKey] ?? properties[formatKey];
            applyCharacterFormat({ [formatKey]: !Boolean(current) });
          } catch (cause) {
            setMessage(cause instanceof Error ? cause.message : "글자 서식을 바꾸지 못했습니다.");
          }
        }
      } else if (key === "+" || key === "=") {
        event.preventDefault();
        setZoom((value) => clampZoom(value + 0.1));
      } else if (key === "-") {
        event.preventDefault();
        setZoom((value) => clampZoom(value - 0.1));
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [runFileCommand, redo, undo, copySelection, pasteText, selection, session, caret, insertPageBreak, applyCharacterFormat, pendingCharacterFormat, printPreviewOpen, tableContextMenu, objectContextMenu, formatDialogTab, headerFooterDialog, documentInfoDialog]);

  const characterProperties = useMemo(() => {
    if (!session || !caret) return {} as Record<string, unknown>;
    try {
      return { ...session.characterProperties(caret), ...pendingCharacterFormat };
    } catch {
      return pendingCharacterFormat as Record<string, unknown>;
    }
  }, [session, caret, pendingCharacterFormat, renderVersion]);

  const paragraphProperties = useMemo(() => {
    if (!session || !caret) return {} as Record<string, unknown>;
    try {
      return session.paragraphProperties(caret);
    } catch {
      return {} as Record<string, unknown>;
    }
  }, [session, caret, renderVersion]);

  const selectedTableLayout = useMemo(() => {
    if (!session || !caret?.cellPath) return null;
    try {
      return session.tableLayout(caret);
    } catch {
      return null;
    }
  }, [session, caret, renderVersion]);

  useEffect(() => {
    setTableDraft(selectedTableLayout);
    setTableDraftUpdates({});
  }, [selectedTableLayout]);

  const updateTableDraftValue = <K extends keyof TableUpdates>(key: K, value: TableUpdates[K]) => {
    setTableDraft((current) => current && ({ ...current, [key]: value }));
    setTableDraftUpdates((current) => ({ ...current, [key]: value }));
  };

  const openFormatDialog = (tab: FormatDialogTab) => {
    if (!session || !caret) return;
    const number = (value: unknown, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const pixelsToMillimeters = (value: unknown) => Math.round(number(value) * 25.4 / 96 * 10) / 10;
    const currentCharacter = characterProperties;
    const currentParagraph = paragraphProperties;
    setCharacterFormatDraft({
      fontFamily: String(currentCharacter.fontFamily ?? "함초롬바탕"),
      fontSizePt: Math.round(number(currentCharacter.fontSize, 1000) / 100 * 10) / 10,
      bold: Boolean(currentCharacter.bold),
      italic: Boolean(currentCharacter.italic),
      underline: Boolean(currentCharacter.underline),
      strikethrough: Boolean(currentCharacter.strikethrough),
    });
    const spacingType = currentParagraph.lineSpacingType;
    setParagraphFormatDraft({
      alignment: ["left", "center", "right", "justify"].includes(String(currentParagraph.alignment))
        ? currentParagraph.alignment as ParagraphFormatDraft["alignment"]
        : "justify",
      lineSpacing: number(currentParagraph.lineSpacing, 160),
      lineSpacingType: ["Percent", "Fixed", "AtLeast"].includes(String(spacingType))
        ? spacingType as ParagraphFormatDraft["lineSpacingType"]
        : "Percent",
      marginLeftMm: pixelsToMillimeters(currentParagraph.marginLeft),
      marginRightMm: pixelsToMillimeters(currentParagraph.marginRight),
      indentMm: pixelsToMillimeters(currentParagraph.indent),
      spacingBeforeMm: pixelsToMillimeters(currentParagraph.spacingBefore),
      spacingAfterMm: pixelsToMillimeters(currentParagraph.spacingAfter),
    });
    setFormatDialogTab(tab);
  };

  const commitFormatDialog = () => {
    if (formatDialogTab === "character" && characterFormatDraft) {
      if (!characterFormatDraft.fontFamily.trim() || !Number.isFinite(characterFormatDraft.fontSizePt) || characterFormatDraft.fontSizePt < 1 || characterFormatDraft.fontSizePt > 500) {
        setMessage("글꼴과 1pt에서 500pt 사이의 글자 크기를 확인하세요.");
        return;
      }
      applyCharacterFormat({
        fontFamily: characterFormatDraft.fontFamily,
        fontSize: Math.round(characterFormatDraft.fontSizePt * 100),
        bold: characterFormatDraft.bold,
        italic: characterFormatDraft.italic,
        underline: characterFormatDraft.underline,
        strikethrough: characterFormatDraft.strikethrough,
      });
    } else if (formatDialogTab === "paragraph" && paragraphFormatDraft) {
      const paragraphValues = [
        paragraphFormatDraft.lineSpacing,
        paragraphFormatDraft.marginLeftMm,
        paragraphFormatDraft.marginRightMm,
        paragraphFormatDraft.indentMm,
        paragraphFormatDraft.spacingBeforeMm,
        paragraphFormatDraft.spacingAfterMm,
      ];
      if (paragraphValues.some((value) => !Number.isFinite(value)) || paragraphFormatDraft.lineSpacing < 10 || paragraphFormatDraft.lineSpacing > 1000) {
        setMessage("문단 서식의 숫자 값을 확인하세요. 줄 간격은 10에서 1000 사이여야 합니다.");
        return;
      }
      const toRaw = (millimeters: number) => Math.round(millimeters * PARAGRAPH_RAW_UNITS_PER_MM);
      applyParagraphFormat({
        alignment: paragraphFormatDraft.alignment,
        lineSpacing: paragraphFormatDraft.lineSpacing,
        lineSpacingType: paragraphFormatDraft.lineSpacingType,
        marginLeft: toRaw(paragraphFormatDraft.marginLeftMm),
        marginRight: toRaw(paragraphFormatDraft.marginRightMm),
        indent: toRaw(paragraphFormatDraft.indentMm),
        spacingBefore: toRaw(paragraphFormatDraft.spacingBeforeMm),
        spacingAfter: toRaw(paragraphFormatDraft.spacingAfterMm),
      });
    }
    setFormatDialogTab(null);
    editInput.current?.focus();
  };

  const documentStyles = useMemo(() => {
    if (!session) return [] as DocumentStyle[];
    try {
      return session.styleList();
    } catch {
      return [] as DocumentStyle[];
    }
  }, [session, renderVersion]);

  const printPageSize = useMemo(() => {
    if (!session) return { widthMm: 210, heightMm: 297 };
    try {
      const firstPage = session.pageInfo(0);
      return {
        widthMm: Math.max(1, Math.round(firstPage.width * 25.4 / 96 * 100) / 100),
        heightMm: Math.max(1, Math.round(firstPage.height * 25.4 / 96 * 100) / 100),
      };
    } catch {
      return { widthMm: 210, heightMm: 297 };
    }
  }, [session]);

  const setFontSize = (fontSize: number) => applyCharacterFormat({ fontSize });
  const toggleCharacterFormat = (key: "bold" | "italic" | "underline") => {
    const value = pendingCharacterFormat[key] ?? characterProperties[key];
    applyCharacterFormat({ [key]: !Boolean(value) });
  };

  const moveToPage = (value: number) => {
    if (!session || !Number.isFinite(value)) return;
    const target = Math.max(1, Math.min(session.pageCount, Math.round(value)));
    setCurrentPage(target);
    setPageInput(String(target));
    reader.current?.scrollToIndex({ index: target - 1, align: "start", behavior: "smooth" });
  };

  const adjustZoom = (delta: number) => setZoom((value) => clampZoom(value + delta));

  return (
    <main className="app-shell">
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept=".hwp,.hwpx"
        onChange={onFileChange}
        aria-label="HWP 또는 HWPX 문서 선택"
      />
      <input
        ref={imageInput}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp"
        onChange={(event) => void onImageFileChange(event)}
        aria-label="문서에 넣을 그림 선택"
      />
      {/* OS IME 조합 이벤트만 받는다. 문서 텍스트는 RHWP 모델이 소유하고 페이지에 렌더링한다. */}
      <textarea
        ref={editInput}
        className="ime-input"
        aria-label="한글 입력 조합 전달"
        lang="ko"
        spellCheck={false}
        autoCapitalize="off"
        tabIndex={session ? 0 : -1}
        onCompositionStart={(event) => {
          imeInputGate.current.startComposition();
          setImePreedit("");
          traceImeEvent("compositionstart", event.nativeEvent, event.currentTarget.value.length);
        }}
        onCompositionUpdate={(event) => {
          imeInputGate.current.updateComposition(event.data);
          setImePreedit(event.data);
          traceImeEvent("compositionupdate", event.nativeEvent, event.currentTarget.value.length);
        }}
        onCompositionEnd={(event) => {
          const committedText = imeInputGate.current.finishComposition(event.data || event.currentTarget.value);
          setImePreedit("");
          traceImeEvent(`compositionend commit=${committedText?.length ?? 0}`, event.nativeEvent, event.currentTarget.value.length);
          if (committedText) insertText(committedText);
          event.currentTarget.value = "";
        }}
        onBeforeInput={(event) => {
          const nativeEvent = event.nativeEvent as InputEvent;
          traceImeEvent("beforeinput", nativeEvent, event.currentTarget.value.length);
        }}
        onFocus={(event) => traceImeEvent("focus", event.nativeEvent, event.currentTarget.value.length)}
        onBlur={(event) => traceImeEvent("blur", event.nativeEvent, event.currentTarget.value.length)}
        onChange={(event) => {
          const nativeEvent = event.nativeEvent as InputEvent;
          if (
            imeInputGate.current.isComposing ||
            nativeEvent.isComposing ||
            nativeEvent.inputType === "insertCompositionText"
          ) {
              imeInputGate.current.updateComposition(nativeEvent.data || event.currentTarget.value);
            setImePreedit(nativeEvent.data || event.currentTarget.value);
            traceImeEvent("preedit-input", nativeEvent, event.currentTarget.value.length);
            return;
          }
          const text = event.currentTarget.value || nativeEvent.data || "";
          const committedText = imeInputGate.current.acceptInput(text, {
            inputType: nativeEvent.inputType,
            isComposing: nativeEvent.isComposing,
          });
          traceImeEvent("input", nativeEvent, event.currentTarget.value.length);
          if (committedText) insertText(committedText);
          event.currentTarget.value = "";
        }}
        onKeyDown={(event) => {
          const nativeEvent = event.nativeEvent;
          imeInputGate.current.noteKeydown(event.key);
          traceImeEvent("keydown", nativeEvent, event.currentTarget.value.length);
            if (event.key === "Escape") { imeInputGate.current.cancelComposition(); setImePreedit(""); }
          if (!imeInputGate.current.shouldHandleKey(nativeEvent.isComposing, nativeEvent.keyCode, event.key)) {
            traceImeEvent("keydown-composing", nativeEvent, event.currentTarget.value.length);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            insertPageBreak();
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            if (!session || !caret) return;
            try {
              const delta = event.key === "ArrowLeft" ? -1 : 1;
              if (event.shiftKey) {
                const anchor = isRangeSelection(selection) ? selection!.anchor : caret;
                const focus = session.moveCaret(caret, delta);
                if (!sameEditorScope(anchor, focus)) return;
                const next = { anchor, focus };
                setSelection(next);
                setCaretPosition(focus);
              } else if (isRangeSelection(selection)) {
                const edge = compareEditorPositions(selection!.anchor, selection!.focus) < 0
                  ? (delta < 0 ? selection!.anchor : selection!.focus)
                  : (delta < 0 ? selection!.focus : selection!.anchor);
                setSelection(null);
                setCaretPosition(edge);
              } else {
                setSelection(null);
                setCaretPosition(session.moveCaret(caret, delta));
              }
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : "커서를 이동하지 못했습니다.");
            }
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            if (!session || !caret) return;
            try {
              const focus = event.key === "ArrowUp"
                ? session.moveCaretVertical(caret, -1)
                : event.key === "ArrowDown"
                  ? session.moveCaretVertical(caret, 1)
                  : session.moveCaretToParagraphEdge(caret, event.key === "Home" ? "start" : "end");
              if (event.shiftKey) {
                const anchor = isRangeSelection(selection) ? selection!.anchor : caret;
                if (!sameEditorScope(anchor, focus)) return;
                setSelection({ anchor, focus });
              } else {
                setSelection(null);
              }
              setCaretPosition(focus);
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : "커서를 이동하지 못했습니다.");
            }
          } else if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            if (event.key === "Delete" && selectedObject) deleteSelectedObject();
            else deleteText(event.key === "Backspace" ? "backward" : "forward");
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (session && caret) {
              try {
                const position = isRangeSelection(selection)
                  ? session.deleteRange(selection!.anchor, selection!.focus)
                  : caret;
                updateAfterEdit(session.splitParagraph(position));
              } catch (cause) {
                setMessage(cause instanceof Error ? cause.message : "문단을 나누지 못했습니다.");
              }
            }
          } else if (event.key === "Tab" && caret?.cellPath) {
            event.preventDefault();
            if (session) {
              try {
                const position = session.moveTableCell(caret, event.shiftKey ? -1 : 1);
                setSelection(null);
                setCaretPosition(position);
              } catch (cause) {
                setMessage(cause instanceof Error ? cause.message : "표 셀을 이동하지 못했습니다.");
              }
            }
          }
        }}
      />

      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">한울</span>
          <span className="brand-caption">문서</span>
        </div>
        <div className="header-divider" />
        <button className="header-action" type="button" onClick={() => void chooseDocument()} disabled={isLoading || isSaving}>
          <Icon name="open" />
          <span>열기</span>
          <kbd>Ctrl O</kbd>
        </button>
        <button className="header-action new-document-action" type="button" onClick={() => void chooseNewDocument()} disabled={isLoading || isSaving}>
          <Icon name="file" />
          <span>새 문서</span>
          <kbd>Ctrl N</kbd>
        </button>
        <div className="header-spacer" />
        <span className="header-document-title" title={fileName || "새 문서"}>
          {fileName || "새 문서"}
        </span>
        <div className="header-spacer" />
        {session && (
          <>
            <button className="header-action compact-action" type="button" onClick={undo} disabled={!session.canUndo} title="실행 취소 (Ctrl Z)">
              <Icon name="undo" size={16} /><span>실행 취소</span>
            </button>
            <button className="header-action compact-action" type="button" onClick={redo} disabled={!session.canRedo} title="다시 실행 (Ctrl Y)">
              <Icon name="redo" size={16} /><span>다시 실행</span>
            </button>
            <button className="header-action save-action" type="button" onClick={() => void saveCurrent()} disabled={!dirty || isSaving || isLoading} title="저장 (Ctrl S)">
              <Icon name="save" size={16} /><span>{isSaving ? "저장 중…" : "저장"}</span>
            </button>
          </>
        )}
        {!session && <span className="mode-label">문서 편집</span>}
      </header>

      <section className="editor-ribbon" aria-label="편집 리본 메뉴">
        <nav className="ribbon-tabs" aria-label="리본 탭">
          <FileMenu items={fileMenuItems} onCommand={runFileCommand} />
          {(["편집", "입력", "보기", "서식", "쪽", "보안", "검토", "도구"] as const).map((tab) => {
            const implemented = tab === "편집" || tab === "입력" || tab === "보기" || tab === "서식" || tab === "쪽";
            return (
              <button
                key={tab}
                className={`ribbon-tab${ribbonTab === tab ? " active" : ""}`}
                type="button"
                disabled={!implemented}
                title={implemented ? undefined : "이 탭의 기능은 아직 구현되지 않았습니다."}
                onClick={() => setRibbonTab(tab)}
              >{tab}</button>
            );
          })}
        </nav>
        <div className="ribbon-content">
          {ribbonTab === "편집" && (
            <>
              <div className="ribbon-group ribbon-history">
                <button className="ribbon-button" type="button" title="실행 취소 (Ctrl Z)" onClick={undo} disabled={!session?.canUndo}><Icon name="undo" size={16} />실행 취소</button>
                <button className="ribbon-button" type="button" title="다시 실행 (Ctrl Y)" onClick={redo} disabled={!session?.canRedo}><Icon name="redo" size={16} />다시 실행</button>
                <span className="ribbon-group-label">기록</span>
              </div>
              <span className="ribbon-divider" />
              <div className="ribbon-group ribbon-clipboard-group">
                <button className="ribbon-button" type="button" disabled={!isRangeSelection(selection)} onMouseDown={(event) => event.preventDefault()} onClick={() => void copySelection(true)}>잘라내기</button>
                <button className="ribbon-button" type="button" disabled={!isRangeSelection(selection)} onMouseDown={(event) => event.preventDefault()} onClick={() => void copySelection(false)}>복사</button>
                <button className="ribbon-button" type="button" disabled={!session || !caret} onMouseDown={(event) => event.preventDefault()} onClick={() => void pasteText()}>붙여넣기</button>
                <span className="ribbon-group-label">클립보드</span>
              </div>
              <span className="ribbon-divider" />
              <div className="ribbon-group ribbon-clipboard-group">
                <button className="ribbon-button" type="button" disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => { setReplaceMode(false); setSearchOpen(true); }}>찾기</button>
                <button className="ribbon-button" type="button" disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => { setReplaceMode(true); setSearchOpen(true); }}>바꾸기</button>
                <span className="ribbon-group-label">검색</span>
              </div>
            </>
          )}

          {ribbonTab === "입력" && <>
            <div className="ribbon-group ribbon-table-group">
              <span className="ribbon-group-title">표</span>
              <label>행 <input aria-label="표 행 수" type="number" min={1} max={30} value={tableRows} onChange={(event) => setTableRows(Math.max(1, Math.min(30, Number(event.currentTarget.value))))} /></label>
              <label>열 <input aria-label="표 열 수" type="number" min={1} max={20} value={tableColumns} onChange={(event) => setTableColumns(Math.max(1, Math.min(20, Number(event.currentTarget.value))))} /></label>
              <button className="ribbon-insert-button" type="button" disabled={!session || !caret || isRangeSelection(selection)} onMouseDown={(event) => event.preventDefault()} onClick={insertTable}>표 삽입</button>
              {caret?.cellPath && <>
                <span className="ribbon-divider" />
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("insertRowAbove")}>위 행</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("insertRowBelow")}>아래 행</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("insertColumnLeft")}>왼쪽 열</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("insertColumnRight")}>오른쪽 열</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("deleteRow")}>행 삭제</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("deleteColumn")}>열 삭제</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("mergeRight")}>오른쪽 셀과 병합</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("mergeDown")}>아래 셀과 병합</button>
                <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => runTableCommand("splitCell")}>셀 나누기</button>
              </>}
              <span className="ribbon-group-label">표 삽입 및 편집</span>
            </div>
            {caret?.cellPath && tableDraft && <>
              <span className="ribbon-divider" />
              <div className="ribbon-group ribbon-table-group ribbon-table-properties">
                <span className="ribbon-group-title">표 / 셀 모양</span>
                <label>너비 <input aria-label="표 너비 mm" type="number" min={10} step={1} value={tableDraft.widthMm.toFixed(1)} onChange={(event) => updateTableDraftValue("widthMm", Number(event.currentTarget.value))} /></label>
                <label>X <input aria-label="표 가로 위치 mm" type="number" step={1} value={tableDraft.offsetXmm.toFixed(1)} onChange={(event) => updateTableDraftValue("offsetXmm", Number(event.currentTarget.value))} /></label>
                <label>Y <input aria-label="표 세로 위치 mm" type="number" step={1} value={tableDraft.offsetYmm.toFixed(1)} onChange={(event) => updateTableDraftValue("offsetYmm", Number(event.currentTarget.value))} /></label>
                <label>정렬 <select aria-label="표 정렬" value={tableDraft.horizontalAlignment} onChange={(event) => updateTableDraftValue("horizontalAlignment", event.currentTarget.value as TableLayoutInfo["horizontalAlignment"])}><option value="Left">왼쪽</option><option value="Center">가운데</option><option value="Right">오른쪽</option></select></label>
                <label>열 너비 <input aria-label="현재 열 너비 mm" type="number" min={5} step={1} value={tableDraft.columnWidthMm.toFixed(1)} onChange={(event) => updateTableDraftValue("columnWidthMm", Number(event.currentTarget.value))} /></label>
                <label>행 높이 <input aria-label="현재 셀 높이 mm" type="number" min={2} step={1} value={tableDraft.rowHeightMm.toFixed(1)} onChange={(event) => updateTableDraftValue("rowHeightMm", Number(event.currentTarget.value))} /></label>
                <label>셀 여백 <input aria-label="셀 여백 mm" type="number" min={0} max={30} step={0.5} value={tableDraft.cellPaddingMm.toFixed(1)} onChange={(event) => updateTableDraftValue("cellPaddingMm", Number(event.currentTarget.value))} /></label>
                <label>배경 <input aria-label="셀 배경색" type="color" value={tableDraft.cellFillColor ?? "#ffffff"} onChange={(event) => updateTableDraftValue("cellFillColor", event.currentTarget.value)} /></label>
                <label>테두리 <input aria-label="셀 테두리 색" type="color" value={tableDraft.cellBorderColor} onChange={(event) => updateTableDraftValue("borderColor", event.currentTarget.value)} /></label>
                <button className="ribbon-button" type="button" disabled={!Object.keys(tableDraftUpdates).length} onMouseDown={(event) => event.preventDefault()} onClick={() => applyTableLayout(tableDraftUpdates)}>적용</button>
                <span className="ribbon-group-label">표 위치와 선택 셀 속성</span>
              </div>
            </>}
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <button className="ribbon-insert-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => imageInput.current?.click()}>그림 넣기</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertShape("rectangle")}>사각형</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertShape("ellipse")}>타원</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertShape("textBox")}>글상자</button>
              <span className="ribbon-group-label">그림·도형</span>
            </div>
            {documentObjects.length > 0 && <>
              <span className="ribbon-divider" />
              <div className="ribbon-group ribbon-object-group">
                <label className="ribbon-control-label" htmlFor="document-object-select">개체 선택</label>
                <select id="document-object-select" className="ribbon-select object-select" aria-label="문서 개체 선택" value={selectedObjectId} onChange={(event) => {
                  const id = event.currentTarget.value;
                  setSelectedObjectId(id);
                  const object = documentObjects.find((candidate) => candidate.id === id);
                  if (object) moveToPage(object.pageIndex + 1);
                }}>
                  <option value="">개체를 선택하세요</option>
                  {documentObjects.map((object, index) => <option key={object.id} value={object.id}>{object.kind === "picture" ? "그림" : object.kind === "textBox" ? "글상자" : object.kind === "ellipse" ? "타원" : "사각형"} {index + 1}</option>)}
                </select>
                {selectedObject && objectEditDraft && <>
                  <div className="object-size-fields">
                    <label>너비 <input aria-label="개체 너비 mm" type="number" min="1" max="1000" step="0.1" value={objectEditDraft.widthMm} onChange={(event) => setObjectEditDraft((current) => current ? { ...current, widthMm: event.currentTarget.value } : current)} /></label>
                    <label>높이 <input aria-label="개체 높이 mm" type="number" min="1" max="1000" step="0.1" value={objectEditDraft.heightMm} onChange={(event) => setObjectEditDraft((current) => current ? { ...current, heightMm: event.currentTarget.value } : current)} /></label>
                    <label>X <input aria-label="개체 X 위치 mm" type="number" min="-500" max="1000" step="0.1" value={objectEditDraft.offsetXmm} onChange={(event) => setObjectEditDraft((current) => current ? { ...current, offsetXmm: event.currentTarget.value } : current)} /></label>
                    <label>Y <input aria-label="개체 Y 위치 mm" type="number" min="-500" max="1000" step="0.1" value={objectEditDraft.offsetYmm} onChange={(event) => setObjectEditDraft((current) => current ? { ...current, offsetYmm: event.currentTarget.value } : current)} /></label>
                  </div>
                  <select className="ribbon-select object-wrap-select" aria-label="개체 글 배치" value={objectEditDraft.textWrap} onChange={(event) => setObjectEditDraft((current) => current ? { ...current, textWrap: event.currentTarget.value as DocumentObjectTextWrap } : current)}>
                    {!isHanulTextEngine && <>
                      <option value="Square">자리 차지</option>
                      <option value="TopAndBottom">위아래</option>
                      <option value="Tight">밀착</option>
                      <option value="Through">통과</option>
                    </>}
                    <option value="BehindText">글 뒤</option>
                    <option value="InFrontOfText">글 앞으로</option>
                  </select>
                  <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={applySelectedObject}>속성 적용</button>
                  <button className="ribbon-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={deleteSelectedObject}>삭제</button>
                </>}
                <span className="ribbon-group-label">개체 편집</span>
              </div>
            </>}
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <label className="ribbon-control-label" htmlFor="special-character">문자표</label>
              <select id="special-character" className="ribbon-select symbol-select" value={specialCharacter} onChange={(event) => setSpecialCharacter(event.currentTarget.value)} disabled={!session}>
                {["※", "•", "○", "●", "◇", "■", "★", "☆", "→", "←", "↑", "↓", "±", "×", "÷", "∞", "℃", "₩"].map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
              </select>
              <button className="ribbon-button" type="button" disabled={!session || !caret} onMouseDown={(event) => event.preventDefault()} onClick={insertSpecialCharacter}>넣기</button>
              <span className="ribbon-group-label">특수 문자</span>
            </div>
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <button className="ribbon-insert-button" type="button" disabled={!isRangeSelection(selection) || isHanulTextEngine} title={isHanulTextEngine ? "하이퍼링크는 아직 구현되지 않았습니다." : isRangeSelection(selection) ? undefined : "먼저 한 문단 안의 글자를 선택하세요."} onMouseDown={(event) => event.preventDefault()} onClick={openHyperlinkDialog}>하이퍼링크</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath) || isHanulTextEngine} title={isHanulTextEngine ? "각주는 아직 구현되지 않았습니다." : undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => insertNote(false)}>각주</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath) || isHanulTextEngine} title={isHanulTextEngine ? "미주는 아직 구현되지 않았습니다." : undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => insertNote(true)}>미주</button>
              <span className="ribbon-group-label">링크 및 주석</span>
            </div>
          </>}

          {ribbonTab === "보기" && <>
            <div className="ribbon-group ribbon-inline-group">
              <button className="ribbon-button" type="button" aria-pressed={pageView === "continuous"} disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => setPageView("continuous")}>연속 쪽</button>
              <button className="ribbon-button" type="button" aria-pressed={pageView === "single"} disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => setPageView("single")}>한 쪽</button>
              <span className="ribbon-group-label">쪽 보기</span>
            </div>
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <button className="icon-button" type="button" aria-label="축소" disabled={!session || zoom <= 0.5} onMouseDown={(event) => event.preventDefault()} onClick={() => adjustZoom(-0.1)}><Icon name="minus" size={16} /></button>
              <input className="zoom-slider" aria-label="확대/축소 비율" type="range" min={50} max={200} step={10} value={Math.round(zoom * 100)} disabled={!session} onChange={(event) => setZoom(clampZoom(Number(event.currentTarget.value) / 100))} />
              <button className="zoom-value" type="button" title="확대 비율 초기화" disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button className="icon-button" type="button" aria-label="확대" disabled={!session || zoom >= 2} onMouseDown={(event) => event.preventDefault()} onClick={() => adjustZoom(0.1)}><Icon name="plus" size={16} /></button>
              <span className="ribbon-group-label">확대/축소</span>
            </div>
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <label className="ribbon-check-label"><input type="checkbox" checked={showRulers} disabled={!session} onChange={(event) => setShowRulers(event.currentTarget.checked)} /> 눈금자</label>
              <span className="ribbon-group-label">화면 표시</span>
            </div>
          </>}

          {ribbonTab === "서식" && <>
            <div className="ribbon-group ribbon-font-group">
              <label className="visually-hidden" htmlFor="font-family">글꼴</label>
              <select id="font-family" className="ribbon-select font-family-select" value={String(characterProperties.fontFamily ?? "함초롬바탕")} disabled={!session} onChange={(event) => applyCharacterFormat({ fontFamily: event.currentTarget.value })}>
                {["함초롬바탕", "함초롬돋움", "맑은 고딕", "바탕", "굴림", "Arial"].map((font) => <option key={font} value={font}>{font}</option>)}
              </select>
              <label className="visually-hidden" htmlFor="font-size">글자 크기</label>
              <select id="font-size" className="ribbon-select font-size-select" value={String(Math.round(Number(characterProperties.fontSize ?? 1000) / 100))} disabled={!session} onChange={(event) => setFontSize(Number(event.currentTarget.value) * 100)}>
                {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
              <div className="ribbon-button-row">
                <button className="ribbon-format-button" type="button" aria-label="굵게" aria-pressed={Boolean(characterProperties.bold)} title="굵게 (Ctrl B)" disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleCharacterFormat("bold")}><strong>B</strong></button>
                <button className="ribbon-format-button italic" type="button" aria-label="기울임" aria-pressed={Boolean(characterProperties.italic)} title="기울임 (Ctrl I)" disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleCharacterFormat("italic")}><em>I</em></button>
                <button className="ribbon-format-button underline" type="button" aria-label="밑줄" aria-pressed={Boolean(characterProperties.underline)} title="밑줄" disabled={!session} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleCharacterFormat("underline")}><span>U</span></button>
              </div>
              <button className="ribbon-button" type="button" disabled={!session || !caret} onMouseDown={(event) => event.preventDefault()} onClick={() => openFormatDialog("character")}>글자 모양…</button>
              <span className="ribbon-group-label">글자 모양</span>
            </div>
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-align-group">
              <div className="ribbon-button-row">
                {([["left", "왼쪽 정렬"], ["center", "가운데 정렬"], ["right", "오른쪽 정렬"], ["justify", "양쪽 정렬"]] as const).map(([align, label]) => (
                  <button key={align} className="ribbon-format-button align-button" type="button" aria-label={label} aria-pressed={paragraphProperties.alignment === align} title={label} disabled={!session || !caret} onMouseDown={(event) => event.preventDefault()} onClick={() => applyAlignment(align)}>{align === "left" ? "≡" : align === "center" ? "≣" : align === "right" ? "≡" : "☷"}</button>
                ))}
              </div>
              <label className="ribbon-control-label" htmlFor="line-spacing">줄 간격</label>
              <select id="line-spacing" className="ribbon-select compact-select" value={String(Number(paragraphProperties.lineSpacing ?? 160))} disabled={!session || !caret || isHanulTextEngine} title={isHanulTextEngine ? "줄 간격 조판은 아직 구현되지 않았습니다." : undefined} onChange={(event) => applyParagraphFormat({ lineSpacing: Number(event.currentTarget.value), lineSpacingType: "Percent" })}>
                {[...new Set([100, 120, 150, 160, 180, 200, Number(paragraphProperties.lineSpacing ?? 160)])].sort((a, b) => a - b).map((spacing) => <option key={spacing} value={spacing}>{spacing}%</option>)}
              </select>
              <label className="ribbon-compact-field" title="문단 왼쪽 여백 (mm)">
                <span>왼쪽 여백</span>
                <input type="number" step="0.5" value={Math.round(Number(paragraphProperties.marginLeft ?? 0) * 25.4 / 96 * 10) / 10} disabled={!session || !caret} onChange={(event) => applyParagraphFormat({ marginLeft: Math.round(Number(event.currentTarget.value) * PARAGRAPH_RAW_UNITS_PER_MM) })} />
              </label>
              <label className="ribbon-compact-field" title="첫 줄 들여쓰기 (mm)">
                <span>첫 줄</span>
                <input type="number" step="0.5" value={Math.round(Number(paragraphProperties.indent ?? 0) * 25.4 / 96 * 10) / 10} disabled={!session || !caret} onChange={(event) => applyParagraphFormat({ indent: Math.round(Number(event.currentTarget.value) * PARAGRAPH_RAW_UNITS_PER_MM) })} />
              </label>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isHanulTextEngine} title={isHanulTextEngine ? "고급 문단 모양은 아직 구현되지 않았습니다." : undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => openFormatDialog("paragraph")}>문단 모양…</button>
              <span className="ribbon-group-label">문단 모양</span>
            </div>
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <label className="ribbon-control-label" htmlFor="paragraph-style">스타일</label>
              <select id="paragraph-style" className="ribbon-select style-select" value="" disabled={!session || !caret || !documentStyles.length} onChange={(event) => applySelectedStyle(Number(event.currentTarget.value))}>
                <option value="">{documentStyles.length ? "스타일 선택" : "사용 가능한 스타일 없음"}</option>
                {documentStyles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
              </select>
              <span className="ribbon-group-label">문서 스타일</span>
            </div>
          </>}

          {ribbonTab === "쪽" && <>
            <div className="ribbon-group ribbon-inline-group">
              <button className="ribbon-insert-button" type="button" disabled={!session || !caret} onMouseDown={(event) => event.preventDefault()} onClick={openPageSetup}>편집 용지</button>
              <span className="ribbon-group-label">용지 설정</span>
            </div>
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <button className="ribbon-insert-button" type="button" disabled={!session || !caret} title="쪽 나누기 (Ctrl+Enter)" onMouseDown={(event) => event.preventDefault()} onClick={insertPageBreak}>쪽 나누기</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || isHanulTextEngine} title={isHanulTextEngine ? "새 문서 엔진은 현재 본문 텍스트만 지원합니다." : undefined} onMouseDown={(event) => event.preventDefault()} onClick={insertPageNumber}>쪽 번호 넣기</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || isHanulTextEngine} title={isHanulTextEngine ? "새 문서 엔진은 현재 본문 텍스트만 지원합니다." : undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => openHeaderFooterDialog("header")}>머리말</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || isHanulTextEngine} title={isHanulTextEngine ? "새 문서 엔진은 현재 본문 텍스트만 지원합니다." : undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => openHeaderFooterDialog("footer")}>꼬리말</button>
              <span className="ribbon-group-label">쪽 구성</span>
            </div>
          </>}
        </div>
      </section>

      {searchOpen && session && <section className="search-panel" aria-label="문서 찾기 및 바꾸기">
        <label className="search-field"><span>찾을 내용</span><input ref={searchInput} aria-label="찾을 내용" value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveSearchMatch(event.shiftKey ? -1 : 1); } if (event.key === "Escape") setSearchOpen(false); }} /></label>
        {replaceMode && <label className="search-field"><span>바꿀 내용</span><input aria-label="바꿀 내용" value={replaceQuery} onChange={(event) => setReplaceQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); if (event.key === "Enter") { event.preventDefault(); replaceCurrentMatch(); } }} /></label>}
        <label className="search-case-option"><input type="checkbox" checked={searchCaseSensitive} onChange={(event) => { setSearchCaseSensitive(event.currentTarget.checked); setSearchMatches([]); setSearchMatchIndex(-1); setSelection(null); }} /> 대소문자 구분</label>
        <button className="ribbon-insert-button" type="button" onClick={searchDocument}>찾기</button>
        <button className="ribbon-button" type="button" disabled={!searchMatches.length} onClick={() => moveSearchMatch(-1)}>이전</button>
        <button className="ribbon-button" type="button" disabled={!searchMatches.length} onClick={() => moveSearchMatch(1)}>다음</button>
        {replaceMode && <>
          <button className="ribbon-button" type="button" disabled={searchMatchIndex < 0} onClick={replaceCurrentMatch}>바꾸기</button>
          <button className="ribbon-button" type="button" disabled={!session || !searchQuery.trim()} onClick={replaceAllMatches}>모두 바꾸기</button>
        </>}
        <span className="search-count">{searchMatches.length ? `${searchMatchIndex + 1} / ${searchMatches.length}` : "검색어를 입력하세요"}</span>
        <button className="icon-button" type="button" aria-label="찾기 닫기" onClick={() => setSearchOpen(false)}>×</button>
      </section>}

      {tableContextMenu && caret?.cellPath && (
        <div className="table-context-scrim" role="presentation" onMouseDown={() => setTableContextMenu(null)}>
          <div
            className="table-context-menu"
            role="menu"
            aria-label="표 셀 편집 명령"
            style={{ left: tableContextMenu.left, top: tableContextMenu.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setTableContextMenu(null); editInput.current?.focus(); } }}
          >
            {TABLE_CONTEXT_COMMANDS.map(({ command, label }, index) => (
              <button
                key={command}
                autoFocus={index === 0}
                role="menuitem"
                type="button"
                onClick={() => runTableCommand(command)}
              >{label}</button>
            ))}
          </div>
        </div>
      )}

      {objectContextMenu && selectedObject && (
        <div className="table-context-scrim" role="presentation" onMouseDown={() => setObjectContextMenu(null)}>
          <div
            className="table-context-menu"
            role="menu"
            aria-label="개체 편집 명령"
            style={{ left: objectContextMenu.left, top: objectContextMenu.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setObjectContextMenu(null); editInput.current?.focus(); } }}
          >
            <button autoFocus role="menuitem" type="button" onClick={() => { setObjectContextMenu(null); setRibbonTab("입력"); }}>개체 속성</button>
            <button role="menuitem" type="button" onClick={() => { setObjectContextMenu(null); deleteSelectedObject(); }}>삭제</button>
          </div>
        </div>
      )}

      <section className="document-bar" aria-label="문서 작업 영역">
        <div className="document-tab">
          <Icon name="file" />
          <span className="document-tab-name" title={fileName || "새 문서"}>
            {fileName || "새 문서"}
          </span>
          {fileName && <span className="format-chip">{isHanulTextEngine ? `${fileFormat || "HWP"} · Hanul 엔진` : fileFormat || session?.sourceFormat}</span>}
        </div>
        <div className="document-tools">
          <span className="tool-label">보기</span>
          <div className="tool-divider" />
          <button className="icon-button" type="button" aria-label="축소" title="축소 (Ctrl -)" onClick={() => adjustZoom(-0.1)} disabled={!session || zoom <= 0.5}>
            <Icon name="minus" size={16} />
          </button>
          <button className="zoom-value" type="button" title="확대 비율 초기화" onClick={() => setZoom(1)} disabled={!session}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-button" type="button" aria-label="확대" title="확대 (Ctrl +)" onClick={() => adjustZoom(0.1)} disabled={!session || zoom >= 2}>
            <Icon name="plus" size={16} />
          </button>
        </div>
      </section>

      <section className="workspace" aria-label="문서 페이지">
        {session ? pageView === "single" ? (
          <div className="single-page-view" aria-label="한 쪽 보기">
            <DocumentPage
              session={session}
              pageIndex={currentPage - 1}
              zoom={zoom}
              renderVersion={renderVersion}
              editMode={editMode}
              caret={caret}
              imePreedit={imePreedit}
              selectionRectsByPage={selectionRectsByPage}
              selectedObject={selectedObject}
              objectPreviewElementRef={objectPreviewElement}
              showRulers={showRulers}
              onPagePointerDown={handlePagePointerDown}
              onPagePointerMove={handlePagePointerMove}
              onPagePointerUp={handlePagePointerUp}
              onPagePointerCancel={handlePagePointerCancel}
              onPageContextMenu={handlePageContextMenu}
            />
          </div>
        ) : (
          <Virtuoso
            ref={reader}
            className="page-list"
            totalCount={session.pageCount}
            defaultItemHeight={1123 * zoom + 86}
            increaseViewportBy={320}
            rangeChanged={(range) => {
              const page = Math.min(session.pageCount, range.startIndex + 1);
              setCurrentPage(page);
              setPageInput(String(page));
            }}
            itemContent={(index) => (
              <DocumentPage
                session={session}
                pageIndex={index}
                zoom={zoom}
                renderVersion={renderVersion}
                editMode={editMode}
                caret={caret}
                imePreedit={imePreedit}
                selectionRectsByPage={selectionRectsByPage}
                selectedObject={selectedObject}
                objectPreviewElementRef={objectPreviewElement}
                showRulers={showRulers}
                onPagePointerDown={handlePagePointerDown}
                onPagePointerMove={handlePagePointerMove}
                onPagePointerUp={handlePagePointerUp}
                onPagePointerCancel={handlePagePointerCancel}
                onPageContextMenu={handlePageContextMenu}
              />
            )}
          />
        ) : (
          <div className="welcome">
            <div className="welcome-art">
              <div className="welcome-page welcome-page-back" />
              <div className="welcome-page welcome-page-front"><span /><span /><span /><span /><i /></div>
            </div>
            <p className="eyebrow">HANUL DOCUMENT</p>
            <h1>한글 문서를 열어보세요</h1>
            <p className="welcome-copy">HWP와 HWPX 파일을 확인하고 본문을 편집하거나 새 HWP 문서를 만들 수 있습니다.</p>
            <button className="open-primary" type="button" onClick={() => void chooseDocument()} disabled={isLoading || isSaving}>
              <Icon name="open" size={17} />{isLoading ? "문서를 여는 중…" : "문서 열기"}
            </button>
            <button className="welcome-new" type="button" onClick={() => void chooseNewDocument()} disabled={isLoading || isSaving}>새 HWP 문서 만들기</button>
            <span className="shortcut-hint">또는 Ctrl + O</span>
          </div>
        )}
        {session && !caret && <div className="edit-hint">페이지에서 입력할 위치를 클릭하세요. 문서의 텍스트와 표 셀을 직접 편집할 수 있습니다.</div>}
        {message && (
          <div className="message-toast" role="alert">
            <span>{message}</span>
            <button type="button" aria-label="알림 닫기" onClick={() => setMessage("")}>닫기</button>
          </div>
        )}
      </section>

      <footer className="status-bar">
        <div className="status-left">
          {isLoading ? (
            <span role="status" aria-live="polite">{loadingStatus || "문서를 여는 중…"}</span>
          ) : session ? (
            <>
              <button className="page-nav" type="button" aria-label="이전 페이지" disabled={currentPage <= 1} onClick={() => moveToPage(currentPage - 1)}><Icon name="chevron-left" size={15} /></button>
              <label className="page-counter">
                <input aria-label="페이지 번호" type="number" min={1} max={session.pageCount} value={pageInput} onChange={(event) => setPageInput(event.currentTarget.value)} onBlur={() => moveToPage(Number(pageInput))} onKeyDown={(event) => { if (event.key === "Enter") moveToPage(Number(pageInput)); }} />
                <span>/ {session.pageCount}쪽</span>
              </label>
              <button className="page-nav" type="button" aria-label="다음 페이지" disabled={currentPage >= session.pageCount} onClick={() => moveToPage(currentPage + 1)}><Icon name="chevron-right" size={15} /></button>
              <span className="status-separator" />
              <span>{formatFileSize(fileSize)}</span>
              {dirty && <span className="dirty-status">저장되지 않은 변경 사항</span>}
            </>
          ) : <span>HWP · HWPX 문서 편집</span>}
        </div>
        <div className="status-right">
          <span>{session ? (caret?.cellPath ? "표 셀 편집" : "문서 편집") : "편집 준비"}</span>
          <span className="status-separator" />
          <span>한울 문서 0.1.0</span>
        </div>
      </footer>

      {printPreviewOpen && session && (
        <section className="print-preview-layer" role="dialog" aria-modal="true" aria-labelledby="print-preview-title">
          <style>{`@media print { @page { size: ${printPageSize.widthMm}mm ${printPageSize.heightMm}mm; margin: 0; } }`}</style>
          <header className="print-preview-toolbar">
            <div className="print-preview-heading">
              <strong id="print-preview-title">인쇄 미리보기</strong>
              <span>{fileName || "새 문서"} · {session.pageCount}쪽</span>
            </div>
            <div className="print-preview-actions">
              <button className="primary-button" type="button" disabled={Boolean(printIssue)} onClick={() => preparePrintRequest("print")}>인쇄</button>
              <button className="secondary-button" type="button" autoFocus onClick={() => { setPrintPreviewOpen(false); setPrintRequest(null); setPrintIssue(""); }}>닫기</button>
            </div>
          </header>
          <p className={`print-preview-guidance${printIssue ? " has-issue" : ""}`} role={printIssue ? "alert" : undefined}>
            {printIssue || "페이지 크기와 배치를 확인한 다음 인쇄를 선택하세요."}
          </p>
          <div className="print-preview-pages" aria-label="문서 인쇄 페이지">
            {Array.from({ length: session.pageCount }, (_, index) => (
              <PrintPreviewPage key={`${renderVersion}-${index}`} session={session} pageIndex={index} />
            ))}
          </div>
        </section>
      )}

      {documentInfoDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDocumentInfoDialog(null); }}>
          <section className="confirm-dialog document-info-dialog" role="dialog" aria-modal="true" aria-labelledby="document-info-title">
            <p className="eyebrow">파일</p>
            <h2 id="document-info-title">문서 정보</h2>
            <dl className="document-info-list">
              <div><dt>파일 이름</dt><dd>{documentInfoDialog.fileName}</dd></div>
              <div><dt>위치</dt><dd>{documentInfoDialog.filePath || "아직 저장하지 않은 문서"}</dd></div>
              <div><dt>형식</dt><dd>{documentInfoDialog.fileFormat.toUpperCase()}</dd></div>
              <div><dt>파일 크기</dt><dd>{documentInfoDialog.fileSize ? formatFileSize(documentInfoDialog.fileSize) : "저장 전"}</dd></div>
              <div><dt>쪽 수</dt><dd>{documentInfoDialog.info.pageCount ?? "정보 없음"}</dd></div>
              <div><dt>구역 수</dt><dd>{documentInfoDialog.info.sectionCount ?? "정보 없음"}</dd></div>
              <div><dt>문서 버전</dt><dd>{documentInfoDialog.info.version || "정보 없음"}</dd></div>
              <div><dt>암호화</dt><dd>{documentInfoDialog.info.encrypted === undefined ? "정보 없음" : documentInfoDialog.info.encrypted ? "암호화됨" : "암호화되지 않음"}</dd></div>
              <div><dt>사용 글꼴</dt><dd>{documentInfoDialog.info.fontsUsed?.length ? documentInfoDialog.info.fontsUsed.join(", ") : "정보 없음"}</dd></div>
            </dl>
            <div className="dialog-actions">
              <button className="primary-button" type="button" autoFocus onClick={() => setDocumentInfoDialog(null)}>닫기</button>
            </div>
          </section>
        </div>
      )}

      {formatDialogTab && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormatDialogTab(null); }}>
          <section className="confirm-dialog format-dialog" role="dialog" aria-modal="true" aria-labelledby="format-dialog-title">
            <p className="eyebrow">서식</p>
            <h2 id="format-dialog-title">{formatDialogTab === "character" ? "글자 모양" : "문단 모양"}</h2>
            <div className="format-dialog-tabs" role="tablist" aria-label="서식 종류">
              <button type="button" role="tab" aria-selected={formatDialogTab === "character"} onClick={() => setFormatDialogTab("character")}>글자</button>
              <button type="button" role="tab" aria-selected={formatDialogTab === "paragraph"} onClick={() => setFormatDialogTab("paragraph")}>문단</button>
            </div>
            {formatDialogTab === "character" && characterFormatDraft && (
              <div className="format-dialog-grid">
                <label className="page-setup-field format-wide-field">
                  <span>글꼴</span>
                  <select value={characterFormatDraft.fontFamily} onChange={(event) => setCharacterFormatDraft((current) => current ? { ...current, fontFamily: event.currentTarget.value } : current)}>
                    {["함초롬바탕", "함초롬돋움", "맑은 고딕", "바탕", "굴림", "Arial"].map((font) => <option key={font} value={font}>{font}</option>)}
                  </select>
                </label>
                <label className="page-setup-field">
                  <span>크기 (pt)</span>
                  <input type="number" min="1" max="500" step="0.1" value={characterFormatDraft.fontSizePt} onChange={(event) => setCharacterFormatDraft((current) => current ? { ...current, fontSizePt: Number(event.currentTarget.value) } : current)} />
                </label>
                <label className="format-check-field"><input type="checkbox" checked={characterFormatDraft.bold} onChange={(event) => setCharacterFormatDraft((current) => current ? { ...current, bold: event.currentTarget.checked } : current)} /> 굵게</label>
                <label className="format-check-field"><input type="checkbox" checked={characterFormatDraft.italic} onChange={(event) => setCharacterFormatDraft((current) => current ? { ...current, italic: event.currentTarget.checked } : current)} /> 기울임</label>
                <label className="format-check-field"><input type="checkbox" checked={characterFormatDraft.underline} onChange={(event) => setCharacterFormatDraft((current) => current ? { ...current, underline: event.currentTarget.checked } : current)} /> 밑줄</label>
                <label className="format-check-field"><input type="checkbox" checked={characterFormatDraft.strikethrough} onChange={(event) => setCharacterFormatDraft((current) => current ? { ...current, strikethrough: event.currentTarget.checked } : current)} /> 취소선</label>
              </div>
            )}
            {formatDialogTab === "paragraph" && paragraphFormatDraft && (
              <div className="format-dialog-grid">
                <label className="page-setup-field">
                  <span>정렬</span>
                  <select value={paragraphFormatDraft.alignment} onChange={(event) => setParagraphFormatDraft((current) => current ? { ...current, alignment: event.currentTarget.value as ParagraphFormatDraft["alignment"] } : current)}>
                    <option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option><option value="justify">양쪽</option>
                  </select>
                </label>
                <label className="page-setup-field">
                  <span>줄 간격 종류</span>
                  <select value={paragraphFormatDraft.lineSpacingType} onChange={(event) => setParagraphFormatDraft((current) => current ? { ...current, lineSpacingType: event.currentTarget.value as ParagraphFormatDraft["lineSpacingType"] } : current)}>
                    <option value="Percent">글자에 비례</option><option value="Fixed">고정값</option><option value="AtLeast">최소값</option>
                  </select>
                </label>
                <label className="page-setup-field">
                  <span>줄 간격 값</span>
                  <input type="number" min="10" max="1000" step="1" value={paragraphFormatDraft.lineSpacing} onChange={(event) => setParagraphFormatDraft((current) => current ? { ...current, lineSpacing: Number(event.currentTarget.value) } : current)} />
                </label>
                {([["marginLeftMm", "왼쪽 여백"], ["marginRightMm", "오른쪽 여백"], ["indentMm", "첫 줄 들여쓰기"], ["spacingBeforeMm", "문단 위 간격"], ["spacingAfterMm", "문단 아래 간격"]] as const).map(([key, label]) => (
                  <label className="page-setup-field" key={key}>
                    <span>{label} (mm)</span>
                    <input type="number" min="-100" max="1000" step="0.1" value={paragraphFormatDraft[key]} onChange={(event) => setParagraphFormatDraft((current) => current ? { ...current, [key]: Number(event.currentTarget.value) } : current)} />
                  </label>
                ))}
              </div>
            )}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => { setFormatDialogTab(null); editInput.current?.focus(); }}>취소</button>
              <button className="primary-button" type="button" onClick={commitFormatDialog}>적용</button>
            </div>
          </section>
        </div>
      )}

      {headerFooterDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHeaderFooterDialog(null); }}>
          <form className="confirm-dialog hyperlink-dialog" role="dialog" aria-modal="true" aria-labelledby="header-footer-title" onSubmit={(event) => { event.preventDefault(); insertHeaderFooter(); }}>
            <p className="eyebrow">쪽 구성</p>
            <h2 id="header-footer-title">{headerFooterDialog.kind === "header" ? "머리말 입력" : "꼬리말 입력"}</h2>
            <p>선택한 페이지 범위의 한 문단 텍스트를 편집합니다. 자동 필드가 포함된 기존 내용은 평문으로 덮어쓸 수 없습니다.</p>
            <label className="page-setup-field">
              <span>적용 범위</span>
              <select value={headerFooterDialog.scope} onChange={(event) => changeHeaderFooterScope(event.currentTarget.value as HeaderFooterScope)}>
                <option value="currentPage">현재 쪽에 적용되는 형식</option>
                <option value="bothPages">양쪽 페이지</option>
                <option value="evenPages">짝수 쪽</option>
                <option value="oddPages">홀수 쪽</option>
              </select>
            </label>
            <label className="page-setup-field">
              <span>내용</span>
              <input autoFocus maxLength={1000} value={headerFooterDialog.text} onChange={(event) => setHeaderFooterDialog((current) => current ? { ...current, text: event.currentTarget.value } : current)} />
            </label>
            <div className="header-footer-fields" aria-label="자동 필드">
              <button className="secondary-button" type="button" onClick={() => insertHeaderFooterField("pageNumber")}>쪽 번호 넣기</button>
              <button className="secondary-button" type="button" onClick={() => insertHeaderFooterField("totalPages")}>전체 쪽 수</button>
              <button className="secondary-button" type="button" onClick={() => insertHeaderFooterField("fileName")}>파일 이름</button>
            </div>
            <div className="dialog-actions">
              {headerFooterDialog.exists && <button className="secondary-button" type="button" onClick={deleteHeaderFooter}>삭제</button>}
              <button className="secondary-button" type="button" onClick={() => { setHeaderFooterDialog(null); editInput.current?.focus(); }}>취소</button>
              <button className="primary-button" type="submit" disabled={!headerFooterDialog.text.trim()}>적용</button>
            </div>
          </form>
        </div>
      )}

      {pageSetupDialog && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-dialog page-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="page-setup-title">
            <p className="eyebrow">쪽 설정</p>
            <h2 id="page-setup-title">편집 용지</h2>
            <p>용지 크기와 여백을 밀리미터 단위로 설정합니다.</p>
            <div className="page-setup-grid">
              <label className="page-setup-field">
                <span>방향</span>
                <select value={pageSetupDialog.form.orientation} onChange={(event) => updatePageOrientation(event.currentTarget.value as PageSetupForm["orientation"])}>
                  <option value="portrait">세로</option>
                  <option value="landscape">가로</option>
                </select>
              </label>
              {([ ["widthMm", "너비"], ["heightMm", "높이"], ["marginLeftMm", "왼쪽 여백"], ["marginRightMm", "오른쪽 여백"], ["marginTopMm", "위쪽 여백"], ["marginBottomMm", "아래쪽 여백"] ] as const).map(([key, label]) => (
                <label className="page-setup-field" key={key}>
                  <span>{label} (mm)</span>
                  <input type="number" min="0" max="1000" step="0.1" value={pageSetupDialog.form[key]} onChange={(event) => setPageSetupDialog((current) => current ? { ...current, form: { ...current.form, [key]: Number(event.currentTarget.value) } } : current)} />
                </label>
              ))}
            </div>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => { setPageSetupDialog(null); editInput.current?.focus(); }}>취소</button>
              <button className="primary-button" type="button" onClick={commitPageSetup}>적용</button>
            </div>
          </section>
        </div>
      )}

      {hyperlinkDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="confirm-dialog hyperlink-dialog" role="dialog" aria-modal="true" aria-labelledby="hyperlink-title" onSubmit={(event) => { event.preventDefault(); commitHyperlink(); }}>
            <p className="eyebrow">입력</p>
            <h2 id="hyperlink-title">하이퍼링크</h2>
            <label className="page-setup-field">
              <span>선택한 글자</span>
              <input value={hyperlinkLabel} readOnly />
            </label>
            <label className="page-setup-field">
              <span>연결 주소</span>
              <input autoFocus type="text" value={hyperlinkUri} placeholder="https://example.com" onChange={(event) => { setHyperlinkUri(event.currentTarget.value); setHyperlinkError(""); }} />
            </label>
            {hyperlinkError && <p className="dialog-validation" role="alert">{hyperlinkError}</p>}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => { setHyperlinkDialogOpen(false); setHyperlinkRange(null); editInput.current?.focus(); }}>취소</button>
              <button className="primary-button" type="submit" disabled={!hyperlinkUri.trim()}>적용</button>
            </div>
          </form>
        </div>
      )}

      {dialogState && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            {dialogState === "unsaved" ? (
              <>
                <p className="eyebrow">저장 확인</p>
                <h2 id="confirm-title">저장하지 않은 변경 사항이 있습니다</h2>
                  <p>
                    {pendingAction?.kind === "open"
                      ? pendingAction.pending.createNew ? "새 문서를 만들기 전에 저장할까요?" : "다른 문서를 열기 전에 저장할까요?"
                      : pendingAction?.kind === "close" ? "문서를 닫기 전에 저장할까요?" : "앱을 종료하기 전에 저장할까요?"}
                  </p>
                <div className="dialog-actions">
                  <button className="secondary-button" type="button" disabled={isSaving} onClick={() => resolvePendingFileAction("cancel")}>취소</button>
                    <button className="secondary-button discard-button" type="button" disabled={isSaving} onClick={() => resolvePendingFileAction("discard")}>저장 안 함</button>
                    <button className="primary-button" type="button" disabled={isSaving} onClick={() => resolvePendingFileAction("save")}>{isSaving ? "저장 중…" : "저장"}</button>
                </div>
              </>
            ) : dialogState === "loss" ? (
              <>
                <p className="eyebrow warning-eyebrow">저장 형식 확인</p>
                <h2 id="confirm-title">일부 내용을 저장하지 못할 수 있습니다</h2>
                <p>변환 보고서에 {saveCandidate?.result.report.count ?? 0}개의 손실 항목이 있습니다. 내용을 확인하고 계속 저장할지 선택하세요.</p>
                <ul className="loss-list">
                  {saveCandidate?.result.report.losses.slice(0, 8).map((loss, index) => (
                    <li key={`${loss.code ?? "loss"}-${index}`}>
                      <strong>{String(loss.subject ?? loss.code ?? `항목 ${index + 1}`)}</strong>
                      <span>{String(loss.message ?? loss.reason ?? "이 형식에서 보존되지 않을 수 있습니다.")}</span>
                    </li>
                  ))}
                  {(saveCandidate?.result.report.count ?? 0) > 8 && <li>그 외 {((saveCandidate?.result.report.count ?? 0) - 8)}개 항목</li>}
                </ul>
                <div className="dialog-actions">
                  <button className="secondary-button" type="button" disabled={isSaving} onClick={cancelDialog}>저장 취소</button>
                  <button className="primary-button warning-button" type="button" disabled={isSaving} onClick={() => void confirmLossSave()}>{isSaving ? "저장 중…" : "손실 가능성을 알고 저장"}</button>
                </div>
              </>
            ) : (
              <>
                <p className="eyebrow warning-eyebrow">PDF 변환 확인</p>
                <h2 id="confirm-title">일부 내용을 PDF에 표시하지 못할 수 있습니다</h2>
                <p>RHWP 변환 보고서에 {pdfCandidate?.result.report.count ?? 0}개의 손실 항목이 있습니다. 아래 항목을 확인한 뒤 계속할 수 있습니다.</p>
                <ul className="loss-list">
                  {pdfCandidate?.result.report.losses.slice(0, 8).map((loss, index) => (
                    <li key={`${loss.code ?? "loss"}-${index}`}>
                      <strong>{String(loss.subject ?? loss.code ?? `항목 ${index + 1}`)}</strong>
                      <span>{String(loss.message ?? loss.reason ?? "PDF에 표시되지 않을 수 있습니다.")}</span>
                    </li>
                  ))}
                  {(pdfCandidate?.result.report.count ?? 0) > 8 && <li>그 외 {((pdfCandidate?.result.report.count ?? 0) - 8)}개 항목</li>}
                </ul>
                <div className="dialog-actions">
                  <button className="secondary-button" type="button" onClick={cancelDialog}>PDF 내보내기 취소</button>
                  <button className="primary-button warning-button" type="button" onClick={() => void confirmPdfLossExport()}>손실 가능성을 알고 계속</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {import.meta.env.DEV && (
        <output className="ime-debug-panel" id="hanul-ime-debug" aria-hidden="true">
          IME event trace: waiting for keyboard input
        </output>
      )}
    </main>
  );
}

function traceImeEvent(type: string, event: Event, valueLength: number) {
  if (!import.meta.env.DEV) return;
  const inputEvent = event as InputEvent;
  const compositionEvent = event as CompositionEvent;
  const keyboardEvent = event as KeyboardEvent;
  const details = {
    inputType: inputEvent.inputType || undefined,
    isComposing: inputEvent.isComposing,
    dataLength: compositionEvent.data?.length ?? inputEvent.data?.length ?? 0,
    keyCode: keyboardEvent.keyCode || undefined,
    valueLength,
  };
  console.debug(`[Hanul IME] ${type}`, details);
  const output = document.getElementById("hanul-ime-debug");
  if (output) {
    output.textContent = `${type} · input=${details.inputType ?? "–"} · composing=${details.isComposing ?? "–"} · data=${details.dataLength} · value=${valueLength} · key=${details.keyCode ?? "–"}`;
  }
}

export default App;
