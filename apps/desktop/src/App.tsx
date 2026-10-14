import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import DOMPurify from "dompurify";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, stat, writeFile } from "@tauri-apps/plugin-fs";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ImeInputGate } from "./ime-input";
import {
  createNewHwpDocumentSession,
  loadHwpDocument,
  type DocumentSession,
  type DocumentInfo,
  type CharacterFormat,
  type DocumentStyle,
  type ExportResult,
  type PageDefinition,
  type ParagraphFormat,
  type SearchMatch,
  type TableCommand,
  type TextPosition,
} from "./hwp-engine";
import {
  clampZoom,
  formatFileSize,
  sanitizeRenderedSvg,
  validateDocumentFile,
} from "./document-utils";
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

type PendingFileAction =
  | { kind: "open"; pending: PendingDocument }
  | { kind: "close" }
  | { kind: "exit" };

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

function getBaseName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function errorDetail(cause: unknown, fallback: string) {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" && cause ? cause : fallback;
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

function addCaret(svg: string, caret: TextPosition | null, pageIndex: number, enabled: boolean) {
  if (!enabled || !caret || caret.cursorRect.pageIndex !== pageIndex) return svg;
  const viewBoxMatch = svg.match(/\bviewBox=["']([^"']+)["']/i);
  if (!viewBoxMatch) return svg;
  const viewBox = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) return svg;
  const width = Math.max(1, viewBox[2] / 794);
  const { x, y, height } = caret.cursorRect;
  if (![x, y, height].every(Number.isFinite)) return svg;
  const line = `<line class="hanul-caret" x1="${x}" y1="${y}" x2="${x}" y2="${y + Math.max(height, 16)}" stroke="#315f86" stroke-width="${width}" />`;
  return svg.replace(/<\/svg>\s*$/i, `${line}</svg>`);
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

function addSelection(
  svg: string,
  session: DocumentSession,
  selection: EditorSelection | null,
  pageIndex: number,
) {
  if (!selection || compareEditorPositions(selection.anchor, selection.focus) === 0) return svg;
  try {
    const rectangles = session.selectionRectangles(selection.anchor, selection.focus)
      .filter((rect) => rect.pageIndex === pageIndex && rect.width > 0 && rect.height > 0)
      .map((rect) => `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="#7bb8ff" fill-opacity="0.42" pointer-events="none" />`)
      .join("");
    return rectangles ? svg.replace(/<\/svg>\s*$/i, `${rectangles}</svg>`) : svg;
  } catch {
    return svg;
  }
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

const HWP_UNITS_PER_MM = 72000 / 25.4;
const PARAGRAPH_RAW_UNITS_PER_MM = 72 * 200 / 25.4;

function pageSetupForm(page: PageDefinition): PageSetupForm {
  const mm = (value: number) => Math.round(value / HWP_UNITS_PER_MM * 10) / 10;
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
  const hu = (value: number) => Math.round(value * HWP_UNITS_PER_MM);
  return {
    width: hu(form.widthMm),
    height: hu(form.heightMm),
    marginLeft: hu(form.marginLeftMm),
    marginRight: hu(form.marginRightMm),
    marginTop: hu(form.marginTopMm),
    marginBottom: hu(form.marginBottomMm),
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
  selection,
  showRulers,
  onPagePointerDown,
  onPagePointerMove,
  onPagePointerUp,
}: {
  session: DocumentSession;
  pageIndex: number;
  zoom: number;
  renderVersion: number;
  editMode: boolean;
  caret: TextPosition | null;
  selection: EditorSelection | null;
  showRulers: boolean;
  onPagePointerDown: (pageIndex: number, event: PointerEvent<HTMLDivElement>) => void;
  onPagePointerMove: (pageIndex: number, event: PointerEvent<HTMLDivElement>) => void;
  onPagePointerUp: (pageIndex: number, event: PointerEvent<HTMLDivElement>) => void;
}) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const pendingSvgCommitStartedAt = useRef<number | null>(null);
  const pageInfo = useMemo(() => session.pageInfo(pageIndex), [session, pageIndex, renderVersion]);

  useEffect(() => {
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
        if (measure) {
          reportAppPerformance("first-page-svg", {
            page: pageIndex + 1,
            sourceSvgCharacters: rendered.length,
            renderMs: Number(renderMs.toFixed(1)),
            sanitizeMs: Number(sanitizeMs.toFixed(1)),
          });
          pendingSvgCommitStartedAt.current = performance.now();
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
  }, [session, pageIndex, renderVersion]);

  useLayoutEffect(() => {
    const startedAt = pendingSvgCommitStartedAt.current;
    if (svg && startedAt !== null) {
      reportAppPerformance("first-page-react-commit", {
        page: pageIndex + 1,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
      });
      pendingSvgCommitStartedAt.current = null;
    }
  }, [pageIndex, svg]);

  const pageSvg = useMemo(
    () => addCaret(addSelection(svg, session, selection, pageIndex), caret, pageIndex, editMode),
    [svg, session, selection, caret, pageIndex, editMode],
  );

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
        {error ? (
          <div className="page-error">
            <Icon name="file" size={24} />
            <strong>이 페이지를 표시할 수 없습니다</strong>
            <span>{error}</span>
          </div>
        ) : svg ? (
          <div
            className={`page-svg${editMode ? " can-edit" : ""}`}
            onPointerDown={(event) => onPagePointerDown(pageIndex, event)}
            onPointerMove={(event) => onPagePointerMove(pageIndex, event)}
            onPointerUp={(event) => onPagePointerUp(pageIndex, event)}
            dangerouslySetInnerHTML={{ __html: pageSvg }}
          />
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
  const allowWindowClose = useRef(false);
  const originalPrintTitle = useRef<string | null>(null);
  const imeInputGate = useRef(new ImeInputGate());
  const pointerSelection = useRef<EditorSelection | null>(null);
  const [session, setSession] = useState<DocumentSession | null>(null);
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
  const [loadingStatus, setLoadingStatus] = useState("");
  const [message, setMessage] = useState("");
  const editMode = Boolean(session);
  const [dirty, setDirty] = useState(false);
  const [caret, setCaret] = useState<TextPosition | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [pendingCharacterFormat, setPendingCharacterFormat] = useState<CharacterFormat>({});
  const [tableRows, setTableRows] = useState(2);
  const [tableColumns, setTableColumns] = useState(2);
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>("편집");
  const [pageSetupDialog, setPageSetupDialog] = useState<PageSetupDialogState | null>(null);
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
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1);
  const [renderVersion, setRenderVersion] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingFileAction | null>(null);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [saveCandidate, setSaveCandidate] = useState<ExportResult | null>(null);
  const [saveDestination, setSaveDestination] = useState<string | null>(null);
  const [pdfCandidate, setPdfCandidate] = useState<PdfExportCandidate | null>(null);
  const [recentDocuments, setRecentDocuments] = useState(() => {
    try {
      return readRecentDocuments(window.localStorage);
    } catch {
      return [];
    }
  });

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
      if (!active || allowWindowClose.current || !dirty) return;
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

    const openStartedAt = performance.now();
    setIsLoading(true);
    setLoadingStatus(pending.createNew ? "새 문서를 구성하는 중…" : "파일을 읽는 중…");
    setMessage("");
    try {
      let bytes = new Uint8Array();
      let nextSession: DocumentSession;
      if (pending.createNew) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
        setLoadingStatus("새 문서의 쪽을 구성하는 중…");
        nextSession = await createNewHwpDocumentSession();
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
        nextSession = await loadHwpDocument(bytes);
      }
      let initialCaret: TextPosition | null = null;
      const hitTestStartedAt = performance.now();
      try {
        initialCaret = nextSession.hitTest(0, 113, 132);
      } catch {
        // Keep opening readable when the first body position is not editable.
      }
      reportAppPerformance("initial-hit-test", {
        durationMs: Number((performance.now() - hitTestStartedAt).toFixed(1)),
      });
      activeSession.current?.dispose();
      activeSession.current = nextSession;
      setSession(nextSession);
      setFileName(pending.name);
      setFilePath(pending.path ?? "");
      setFileFormat(nextSession.sourceFormat === "hwpx" ? "hwpx" : "hwp");
      setDocumentInfoDialog(null);
      setPrintPreviewOpen(false);
      setPrintRequest(null);
      if (pending.path) rememberRecent(pending.path, pending.name);
      setFileSize(pending.createNew ? 0 : bytes.byteLength);
      setDirty(false);
      setCaret(initialCaret);
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
          if (activeSession.current === nextSession) editInput.current?.focus();
        });
      }
      reportAppPerformance("document-session-ready", {
        totalMs: Number((performance.now() - openStartedAt).toFixed(1)),
        bytes: bytes.byteLength,
        pages: nextSession.pageCount,
      });
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? `문서를 열지 못했습니다. 파일 형식이나 손상 여부를 확인해 주세요. (${cause.message})`
          : "문서를 열지 못했습니다. 파일 형식이나 손상 여부를 확인해 주세요.",
      );
    } finally {
      setIsLoading(false);
      setLoadingStatus("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }, [rememberRecent]);

  const openDocument = useCallback(
    async (pending: PendingDocument) => {
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
    setMessage("");
    await openDocument({ name: "새 문서.hwp", size: 0, createNew: true });
  }, [openDocument]);

  const clearDocument = useCallback(() => {
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
    if (!session) return;
    if (dirty) {
      setPendingAction({ kind: "close" });
      setDialogState("unsaved");
    } else {
      clearDocument();
    }
  }, [clearDocument, dirty, session]);

  const requestExitApp = useCallback(() => {
    if (dirty) {
      setPendingAction({ kind: "exit" });
      setDialogState("unsaved");
    } else {
      void exitApp();
    }
  }, [dirty, exitApp]);

  const saveExport = useCallback(
    async (result: ExportResult, destinationPath: string | null) => {
      try {
        let savedPath = "";
        if (isTauri()) {
          if (!destinationPath) throw new Error("저장 경로를 선택하지 않았습니다.");
          await writeFile(destinationPath, result.bytes);
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
        setDirty(false);
        setSaveCandidate(null);
        setSaveDestination(null);
        setDialogState(null);
        setMessage("문서를 저장했습니다.");
        return true;
      } catch (cause) {
        setMessage(cause instanceof Error ? `저장하지 못했습니다. (${cause.message})` : "문서를 저장하지 못했습니다.");
        return false;
      }
    },
    [fileName, filePath, rememberRecent],
  );

  const saveCurrent = useCallback(async (saveAs = false) => {
    if (!session) return;
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

      const result = session.exportWithReport(format);
      if (result.report.count > 0) {
        setSaveCandidate(result);
        setSaveDestination(destinationPath);
        setDialogState("loss");
        return;
      }
      const saved = await saveExport(result, destinationPath);
      if (saved && pendingAction) await continuePendingAction();
    } catch (cause) {
      setMessage(cause instanceof Error ? `저장을 준비하지 못했습니다. (${cause.message})` : "저장을 준비하지 못했습니다.");
    }
  }, [continuePendingAction, fileFormat, fileName, filePath, pendingAction, saveExport, session]);

  const confirmLossSave = useCallback(async () => {
    if (!saveCandidate) return;
    const saved = await saveExport(saveCandidate, saveDestination);
    if (saved && pendingAction) await continuePendingAction();
  }, [continuePendingAction, pendingAction, saveCandidate, saveDestination, saveExport]);

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

  const cancelDialog = () => {
    setDialogState(null);
    setPendingAction(null);
    setSaveCandidate(null);
    setSaveDestination(null);
    setPdfCandidate(null);
  };

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
    { hasDocument: Boolean(session), canEditPage: Boolean(session && caret), canExit: isTauri(), canExportPdf: isTauri() },
  ), [recentDocuments, session, caret]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) void openDocument({ name: file.name, size: file.size, file });
  };

  const setCaretPosition = (position: TextPosition) => {
    setCaret(position);
    setCurrentPage(position.cursorRect.pageIndex + 1);
    setPageInput(String(position.cursorRect.pageIndex + 1));
  };

  const hitPositionFromPointer = (pageIndex: number, event: PointerEvent<HTMLDivElement>) => {
    if (!session) return null;
    const svg = event.currentTarget.querySelector("svg");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    if (rect.width <= 0 || rect.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return null;
    const x = viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width;
    const y = viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.height;
    return session.hitTest(pageIndex, x, y);
  };

  const handlePagePointerDown = (pageIndex: number, event: PointerEvent<HTMLDivElement>) => {
    if (!session) return;
    event.preventDefault();
    try {
      const position = hitPositionFromPointer(pageIndex, event);
      if (!position) return;
      const next = { anchor: position, focus: position };
      pointerSelection.current = next;
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
    const active = pointerSelection.current;
    if (!session || !active) return;
    try {
      const focus = hitPositionFromPointer(pageIndex, event);
      if (!focus) return;
      const next = { anchor: active.anchor, focus };
      if (!sameEditorScope(next.anchor, next.focus)) return;
      pointerSelection.current = next;
      setSelection(next);
      setCaretPosition(focus);
    } catch {
      // 드래그가 본문 바깥을 지나가면 마지막 유효 위치를 유지한다.
    }
  };

  const handlePagePointerUp = (_pageIndex: number, event: PointerEvent<HTMLDivElement>) => {
    pointerSelection.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const updateAfterEdit = (position: TextPosition) => {
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
      const targetWidth = bitmap.width * 75;
      const targetHeight = bitmap.height * 75;
      const scale = Math.min(1, contentWidth / targetWidth, (page.height * 0.7) / targetHeight);
      const format = extension === "jpeg" ? "jpg" : extension;
      updateAfterEdit(session.insertPicture(
        caret,
        new Uint8Array(await file.arrayBuffer()),
        format,
        bitmap.width,
        bitmap.height,
        Math.round(targetWidth * scale),
        Math.round(targetHeight * scale),
      ));
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
    try {
      updateAfterEdit(session.editTable(caret, command));
      editInput.current?.focus();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "표 편집을 적용하지 못했습니다.");
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
      const matches = session.searchText(searchQuery, true);
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
      const result = session.replaceAllText(searchQuery, replaceQuery);
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
  }, [runFileCommand, redo, undo, copySelection, pasteText, selection, session, caret, insertPageBreak, applyCharacterFormat, pendingCharacterFormat, printPreviewOpen]);

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
          traceImeEvent("compositionstart", event.nativeEvent, event.currentTarget.value.length);
        }}
        onCompositionUpdate={(event) => {
          imeInputGate.current.updateComposition(event.data);
          traceImeEvent("compositionupdate", event.nativeEvent, event.currentTarget.value.length);
        }}
        onCompositionEnd={(event) => {
          const committedText = imeInputGate.current.finishComposition(event.data || event.currentTarget.value);
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
            if (event.key === "Escape") imeInputGate.current.cancelComposition();
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
            deleteText(event.key === "Backspace" ? "backward" : "forward");
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
        <button className="header-action" type="button" onClick={() => void chooseDocument()} disabled={isLoading}>
          <Icon name="open" />
          <span>열기</span>
          <kbd>Ctrl O</kbd>
        </button>
        <button className="header-action new-document-action" type="button" onClick={() => void chooseNewDocument()} disabled={isLoading}>
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
            <button className="header-action save-action" type="button" onClick={() => void saveCurrent()} disabled={!dirty} title="저장 (Ctrl S)">
              <Icon name="save" size={16} /><span>저장</span>
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
            <span className="ribbon-divider" />
            <div className="ribbon-group ribbon-inline-group">
              <button className="ribbon-insert-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => imageInput.current?.click()}>그림 넣기</button>
              <span className="ribbon-group-label">그림</span>
            </div>
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
              <button className="ribbon-insert-button" type="button" disabled={!isRangeSelection(selection)} title={isRangeSelection(selection) ? undefined : "먼저 한 문단 안의 글자를 선택하세요."} onMouseDown={(event) => event.preventDefault()} onClick={openHyperlinkDialog}>하이퍼링크</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertNote(false)}>각주</button>
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection) || Boolean(caret?.cellPath)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertNote(true)}>미주</button>
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
              <select id="line-spacing" className="ribbon-select compact-select" value={String(Number(paragraphProperties.lineSpacing ?? 160))} disabled={!session || !caret} onChange={(event) => applyParagraphFormat({ lineSpacing: Number(event.currentTarget.value), lineSpacingType: "Percent" })}>
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
              <button className="ribbon-button" type="button" disabled={!session || !caret || isRangeSelection(selection)} onMouseDown={(event) => event.preventDefault()} onClick={insertPageNumber}>쪽 번호 넣기</button>
              <span className="ribbon-group-label">쪽 구성</span>
            </div>
          </>}
        </div>
      </section>

      {searchOpen && session && <section className="search-panel" aria-label="문서 찾기 및 바꾸기">
        <label className="search-field"><span>찾을 내용</span><input ref={searchInput} aria-label="찾을 내용" value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveSearchMatch(event.shiftKey ? -1 : 1); } if (event.key === "Escape") setSearchOpen(false); }} /></label>
        {replaceMode && <label className="search-field"><span>바꿀 내용</span><input aria-label="바꿀 내용" value={replaceQuery} onChange={(event) => setReplaceQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); if (event.key === "Enter") { event.preventDefault(); replaceCurrentMatch(); } }} /></label>}
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

      <section className="document-bar" aria-label="문서 작업 영역">
        <div className="document-tab">
          <Icon name="file" />
          <span className="document-tab-name" title={fileName || "새 문서"}>
            {fileName || "새 문서"}
          </span>
          {fileName && <span className="format-chip">{fileFormat || session?.sourceFormat}</span>}
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
              selection={selection}
              showRulers={showRulers}
              onPagePointerDown={handlePagePointerDown}
              onPagePointerMove={handlePagePointerMove}
              onPagePointerUp={handlePagePointerUp}
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
                selection={selection}
                showRulers={showRulers}
                onPagePointerDown={handlePagePointerDown}
                onPagePointerMove={handlePagePointerMove}
                onPagePointerUp={handlePagePointerUp}
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
            <button className="open-primary" type="button" onClick={() => void chooseDocument()} disabled={isLoading}>
              <Icon name="open" size={17} />{isLoading ? "문서를 여는 중…" : "문서 열기"}
            </button>
            <button className="welcome-new" type="button" onClick={() => void chooseNewDocument()} disabled={isLoading}>새 HWP 문서 만들기</button>
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
                  <button className="secondary-button" type="button" onClick={cancelDialog}>취소</button>
                    <button className="secondary-button discard-button" type="button" onClick={() => void discardPendingAction()}>저장 안 함</button>
                    <button className="primary-button" type="button" onClick={() => void saveCurrent()}>저장</button>
                </div>
              </>
            ) : dialogState === "loss" ? (
              <>
                <p className="eyebrow warning-eyebrow">저장 형식 확인</p>
                <h2 id="confirm-title">일부 내용을 저장하지 못할 수 있습니다</h2>
                <p>변환 보고서에 {saveCandidate?.report.count ?? 0}개의 손실 항목이 있습니다. 내용을 확인하고 계속 저장할지 선택하세요.</p>
                <ul className="loss-list">
                  {saveCandidate?.report.losses.slice(0, 8).map((loss, index) => (
                    <li key={`${loss.code ?? "loss"}-${index}`}>
                      <strong>{String(loss.subject ?? loss.code ?? `항목 ${index + 1}`)}</strong>
                      <span>{String(loss.message ?? loss.reason ?? "이 형식에서 보존되지 않을 수 있습니다.")}</span>
                    </li>
                  ))}
                  {(saveCandidate?.report.count ?? 0) > 8 && <li>그 외 {((saveCandidate?.report.count ?? 0) - 8)}개 항목</li>}
                </ul>
                <div className="dialog-actions">
                  <button className="secondary-button" type="button" onClick={cancelDialog}>저장 취소</button>
                  <button className="primary-button warning-button" type="button" onClick={() => void confirmLossSave()}>손실 가능성을 알고 저장</button>
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
