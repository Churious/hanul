export type FileMenuCommand =
  | "new-document"
  | "open-document"
  | "save-document"
  | "save-as"
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

const unsupportedReason = "이 기능은 아직 구현되지 않았습니다.";

function unavailable<K extends keyof typeof FILE_MENU_SUPPORT>(
  feature: K,
  id: string,
  label: string,
  icon: string,
  children?: FileMenuItem[],
): FileMenuItem {
  const capability = FILE_MENU_SUPPORT[feature];
  return {
    id,
    label,
    icon,
    disabled: !capability.supported,
    disabledReason: capability.supported ? undefined : capability.reason,
    ...(children ? { children } : {}),
  };
}

const separator = (id: string): FileMenuEntry => ({ id, kind: "separator" });

/** Central menu capability map: disabled commands have no application handler yet. */
export const FILE_MENU_SUPPORT = {
  newDocument: { supported: true },
  documentGarden: { supported: false, reason: unsupportedReason },
  startAssistant: { supported: false, reason: unsupportedReason },
  openDocument: { supported: true },
  convertPdf: { supported: false, reason: unsupportedReason },
  convertImage: { supported: false, reason: unsupportedReason },
  xmlDocument: { supported: false, reason: unsupportedReason },
  saveDocument: { supported: true },
  saveAs: { supported: true },
  savePdf: { supported: false, reason: unsupportedReason },
  saveMobile: { supported: false, reason: unsupportedReason },
  documentInfo: { supported: false, reason: unsupportedReason },
  daisy: { supported: false, reason: unsupportedReason },
  ccl: { supported: false, reason: unsupportedReason },
  publicNuri: { supported: false, reason: unsupportedReason },
  braille: { supported: false, reason: unsupportedReason },
  send: { supported: false, reason: unsupportedReason },
  pageSetup: { supported: false, reason: unsupportedReason },
  preview: { supported: false, reason: unsupportedReason },
  print: { supported: false, reason: unsupportedReason },
  recentDocuments: { supported: true },
  closeDocument: { supported: true },
  exit: { supported: true },
} as const;

export interface RecentFileMenuItem {
  path: string;
  label: string;
}

export function createFileMenuItems(
  recentDocuments: RecentFileMenuItem[],
  state: { hasDocument: boolean; canExit: boolean },
): FileMenuEntry[] {
  const recentChildren: FileMenuItem[] = recentDocuments.length
    ? recentDocuments.map((recent, index) => ({
        id: `recent-${index}`,
        label: recent.label,
        icon: "recent",
        command: "open-recent",
        argument: recent.path,
        disabledReason: recent.path,
      }))
    : [{
        id: "recent-empty",
        label: "최근 문서가 없습니다",
        disabled: true,
        disabledReason: "문서를 열거나 저장하면 최근 문서에 표시됩니다.",
      }];

  return [
    { id: "new-document", label: "새 문서", shortcut: "Ctrl+N", icon: "new", command: "new-document" },
    unavailable("documentGarden", "document-garden", "문서마당", "templates"),
    unavailable("startAssistant", "start-assistant", "문서 시작 도우미", "assistant"),
    separator("before-open"),
    { id: "open-document", label: "불러오기", shortcut: "Ctrl+O", icon: "open", command: "open-document" },
    unavailable("convertPdf", "convert-pdf", "PDF를 오피스 문서로 변환하기", "convert"),
    unavailable("convertImage", "convert-image", "그림을 오피스 문서로 변환하기", "image"),
    unavailable("xmlDocument", "xml-document", "XML 문서", "xml"),
    separator("before-save"),
    { id: "save-document", label: "저장하기", shortcut: "Ctrl+S", icon: "save", command: "save-document", disabled: !state.hasDocument },
    { id: "save-as", label: "다른 이름으로 저장하기", shortcut: "Ctrl+Shift+S", icon: "save-as", command: "save-as", disabled: !state.hasDocument },
    unavailable("savePdf", "save-pdf", "PDF로 저장하기", "pdf"),
    unavailable("saveMobile", "save-mobile", "모바일 최적화 문서로 저장하기", "mobile"),
    unavailable("documentInfo", "document-info", "문서 정보", "info"),
    separator("before-accessibility"),
    unavailable("daisy", "daisy", "DAISY 문서", "accessibility"),
    unavailable("ccl", "ccl", "CCL 넣기", "license"),
    unavailable("publicNuri", "public-nuri", "공공누리 넣기", "license"),
    unavailable("braille", "braille", "점자로 바꾸기", "accessibility"),
    separator("before-send"),
    unavailable("send", "send", "보내기", "send", [
      unavailable("send", "send-mail", "메일로 보내기", "send"),
      unavailable("send", "send-link", "링크로 보내기", "send"),
    ]),
    separator("before-page"),
    unavailable("pageSetup", "page-setup", "편집 용지", "page"),
    unavailable("preview", "preview", "미리 보기", "preview"),
    unavailable("print", "print", "인쇄", "print"),
    separator("before-recent"),
    {
      id: "recent-documents",
      label: "최근 문서",
      icon: "recent",
      children: recentChildren,
      disabled: !state.hasDocument && recentDocuments.length === 0,
      disabledReason: recentDocuments.length === 0 ? "문서를 열거나 저장하면 최근 문서에 표시됩니다." : undefined,
    },
    separator("before-close"),
    { id: "close-document", label: "문서 닫기", icon: "close", command: "close-document", disabled: !state.hasDocument },
    { id: "exit", label: "끝", icon: "exit", command: "exit-app", disabled: !state.canExit },
  ];
}

