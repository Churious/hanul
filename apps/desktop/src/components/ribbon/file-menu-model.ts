export type FileMenuCommand =
  | "new-document"
  | "open-document"
  | "save-document"
  | "save-as"
  | "export-pdf"
  | "document-info"
  | "page-setup"
  | "print-preview"
  | "print"
  | "close-document"
  | "exit-app"
  | "open-recent";

export interface FileMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  command?: FileMenuCommand;
  argument?: string;
  disabled?: boolean;
  disabledReason?: string;
  children?: FileMenuItem[];
}

export type FileMenuEntry = FileMenuItem | { id: string; kind: "separator" };

/** Visible file-menu commands and their implementation status live in one place. */
export const FILE_MENU_SUPPORT = {
  newDocument: { supported: true },
  openDocument: { supported: true },
  saveDocument: { supported: true },
  saveAs: { supported: true },
  exportPdf: { supported: true },
  documentInfo: { supported: true },
  pageSetup: { supported: true },
  printPreview: { supported: true },
  print: { supported: true },
  recentDocuments: { supported: true },
  closeDocument: { supported: true },
  exit: { supported: true },
} as const;

export interface RecentFileMenuItem {
  path: string;
  label: string;
}

function isSupported(feature: keyof typeof FILE_MENU_SUPPORT) {
  return FILE_MENU_SUPPORT[feature].supported;
}

export function createFileMenuItems(
  recentDocuments: RecentFileMenuItem[],
  state: { hasDocument: boolean; canEditPage: boolean; canExit: boolean; canExportPdf: boolean; isSaving?: boolean },
): FileMenuEntry[] {
  const isSaving = Boolean(state.isSaving);
  const recentChildren: FileMenuItem[] = recentDocuments.length
    ? recentDocuments.map((recent, index) => ({
        id: `recent-${index}`,
        label: recent.label,
        icon: "recent",
        command: "open-recent",
        argument: recent.path,
        disabled: isSaving,
        disabledReason: recent.path,
      }))
    : [{
        id: "recent-empty",
        label: "최근 문서가 없습니다",
        disabled: true,
        disabledReason: "문서를 열거나 저장하면 최근 문서에 표시됩니다.",
      }];

  const separator = (id: string): FileMenuEntry => ({ id, kind: "separator" });

  return [
    { id: "new-document", label: "새 문서", shortcut: "Ctrl+N", icon: "new", command: "new-document", disabled: !isSupported("newDocument") || isSaving },
    separator("before-open"),
    { id: "open-document", label: "불러오기", shortcut: "Ctrl+O", icon: "open", command: "open-document", disabled: !isSupported("openDocument") || isSaving },
    separator("before-save"),
    { id: "save-document", label: "저장하기", shortcut: "Ctrl+S", icon: "save", command: "save-document", disabled: !isSupported("saveDocument") || !state.hasDocument || isSaving },
    { id: "save-as", label: "다른 이름으로 저장하기", shortcut: "Ctrl+Shift+S", icon: "save-as", command: "save-as", disabled: !isSupported("saveAs") || !state.hasDocument || isSaving },
    { id: "export-pdf", label: "PDF로 내보내기", icon: "pdf", command: "export-pdf", disabled: !isSupported("exportPdf") || !state.hasDocument || !state.canExportPdf, disabledReason: !state.canExportPdf ? "PDF 파일 내보내기는 데스크톱 앱에서 사용할 수 있습니다." : undefined },
    separator("before-info"),
    { id: "document-info", label: "문서 정보", icon: "info", command: "document-info", disabled: !isSupported("documentInfo") || !state.hasDocument },
    separator("before-page"),
    { id: "page-setup", label: "편집 용지", icon: "page", command: "page-setup", disabled: !isSupported("pageSetup") || !state.hasDocument || !state.canEditPage, disabledReason: state.hasDocument && !state.canEditPage ? "페이지의 편집 위치를 먼저 선택하세요." : undefined },
    { id: "preview", label: "인쇄 미리보기", icon: "preview", command: "print-preview", disabled: !isSupported("printPreview") || !state.hasDocument },
    { id: "print", label: "인쇄", shortcut: "Ctrl+P", icon: "print", command: "print", disabled: !isSupported("print") || !state.hasDocument },
    separator("before-recent"),
    {
      id: "recent-documents",
      label: "최근 문서",
      icon: "recent",
      children: recentChildren,
      disabled: !isSupported("recentDocuments") || recentDocuments.length === 0 || isSaving,
      disabledReason: recentDocuments.length === 0 ? "문서를 열거나 저장하면 최근 문서에 표시됩니다." : undefined,
    },
    separator("before-close"),
    { id: "close-document", label: "문서 닫기", icon: "close", command: "close-document", disabled: !isSupported("closeDocument") || !state.hasDocument || isSaving },
    { id: "exit", label: "끝", icon: "exit", command: "exit-app", disabled: !isSupported("exit") || !state.canExit || isSaving },
  ];
}
