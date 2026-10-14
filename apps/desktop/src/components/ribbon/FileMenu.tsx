import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileMenuCommand, FileMenuEntry, FileMenuItem } from "./file-menu-model";
import "./FileMenu.css";

interface FileMenuProps {
  items: FileMenuEntry[];
  onCommand: (command: FileMenuCommand, argument?: string) => void;
}

function isSeparator(entry: FileMenuEntry): entry is { id: string; kind: "separator" } {
  return "kind" in entry && entry.kind === "separator";
}

function findMenuItem(entries: FileMenuEntry[], id: string): FileMenuItem | undefined {
  for (const entry of entries) {
    if (isSeparator(entry)) continue;
    if (entry.id === id) return entry;
    if (entry.children) {
      const child = findMenuItem(entry.children, id);
      if (child) return child;
    }
  }
  return undefined;
}

interface SubmenuPosition {
  left: number;
  top: number;
  ready: boolean;
}

function MenuIcon({ name }: { name?: string }) {
  const paths: Record<string, ReactNode> = {
    new: <><path d="M12 4v16M4 12h16" /></>,
    open: <><path d="M3 7.5h7l2 2H21v9.75a1.75 1.75 0 0 1-1.75 1.75H4.75A1.75 1.75 0 0 1 3 19.25Z" /><path d="M3 11h18" /></>,
    save: <><path d="M4 3.5h13l3.5 3.5v13.5H3.5v-15A2 2 0 0 1 4 3.5Z" /><path d="M7 4v6h9V4M7 20v-7h10v7" /></>,
    "save-as": <><path d="M4 3.5h13l3.5 3.5v13.5H3.5v-15A2 2 0 0 1 4 3.5Z" /><path d="M7 20v-7h10v7M7 4v4" /><path d="m15 11 4-4" /></>,
    pdf: <><path d="M6 2.75h8l5 5v13.5H6a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M8 13h8M8 16h6" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    page: <><path d="M4 4h16v16H4z" /><path d="M7 7h10M7 10h10M7 17h10" /></>,
    preview: <><path d="M3 4h18v16H3z" /><path d="M7 8h10M7 11h10M7 14h7" /></>,
    print: <><path d="M7 8V3.5h10V8M7 17H4.5A1.5 1.5 0 0 1 3 15.5v-6A1.5 1.5 0 0 1 4.5 8h15A1.5 1.5 0 0 1 21 9.5v6a1.5 1.5 0 0 1-1.5 1.5H17" /><path d="M7 14h10v6.5H7zM17.5 11h.01" /></>,
    recent: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    close: <><path d="m5 5 14 14M19 5 5 19" /></>,
    exit: <><path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" /></>,
  };
  return (
    <span className="file-menu-icon" aria-hidden="true">
      {name && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="square" strokeLinejoin="miter">{paths[name] ?? paths.page}</svg>}
    </span>
  );
}

export function FileMenu({ items, onCommand }: FileMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [submenuId, setSubmenuId] = useState<string | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<SubmenuPosition | null>(null);
  const activeSubmenu = submenuId ? findMenuItem(items, submenuId) : undefined;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setSubmenuId(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      close();
    };
    const onResize = () => setSubmenuId(null);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !submenuId || !activeSubmenu?.children || !submenuRef.current) {
      setSubmenuPosition(null);
      return;
    }

    const positionSubmenu = () => {
      const anchor = rootRef.current?.querySelector<HTMLButtonElement>(
        `[data-submenu-id="${CSS.escape(submenuId)}"]`,
      );
      const submenu = submenuRef.current;
      if (!anchor || !submenu) return;
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = submenu.getBoundingClientRect();
      const gap = 2;
      const edge = 8;
      const opensLeft = anchorRect.right + menuRect.width + gap > window.innerWidth - edge;
      const left = opensLeft
        ? Math.max(edge, anchorRect.left - menuRect.width - gap)
        : Math.min(window.innerWidth - menuRect.width - edge, anchorRect.right + gap);
      const top = Math.max(edge, Math.min(anchorRect.top, window.innerHeight - menuRect.height - edge));
      setSubmenuPosition({ left, top, ready: true });
    };

    positionSubmenu();
    window.addEventListener("resize", positionSubmenu);
    return () => window.removeEventListener("resize", positionSubmenu);
  }, [activeSubmenu, open, submenuId]);

  const focusEnabled = (list: HTMLElement, direction: 1 | -1, edge?: "first" | "last") => {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>(":scope > li > button:not(:disabled)")];
    if (!buttons.length) return;
    const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = edge === "first" ? 0 : edge === "last" ? buttons.length - 1 : (activeIndex + direction + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const target = event.target as HTMLElement;
    const list = target.closest<HTMLElement>("[data-menu-list]");
    if (!list) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusEnabled(list, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusEnabled(list, 1, event.key === "Home" ? "first" : "last");
    } else if (event.key === "ArrowRight") {
      const item = target.closest<HTMLButtonElement>("button[data-submenu-id]");
      if (item) {
        event.preventDefault();
        const id = item.dataset.submenuId;
        if (id) {
          setSubmenuPosition(null);
          setSubmenuId(id);
          requestAnimationFrame(() => submenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
        }
      }
    } else if (event.key === "ArrowLeft" && list.dataset.menuList === "submenu") {
      event.preventDefault();
      setSubmenuId(null);
      const parentId = list.dataset.parentId;
      if (parentId) rootRef.current?.querySelector<HTMLButtonElement>(`[data-submenu-id="${CSS.escape(parentId)}"]`)?.focus();
    }
  };

  const runItem = (item: FileMenuItem) => {
    if (item.disabled) return;
    if (item.children) {
      setSubmenuPosition(null);
      setSubmenuId(item.id);
      return;
    }
    close();
    if (item.command) onCommand(item.command, item.argument);
  };

  const renderItem = (item: FileMenuItem) => (
    <li key={item.id} className="file-menu-entry">
      <button
        type="button"
        role="menuitem"
        className="file-menu-item"
        disabled={item.disabled}
        aria-haspopup={item.children ? "menu" : undefined}
        aria-expanded={item.children ? submenuId === item.id : undefined}
        aria-describedby={item.disabledReason ? `file-menu-reason-${item.id}` : undefined}
        data-submenu-id={item.children ? item.id : undefined}
        onPointerEnter={() => {
          if (!item.children || item.disabled || submenuId === item.id) return;
          setSubmenuPosition(null);
          setSubmenuId(item.id);
        }}
        onClick={() => runItem(item)}
        title={item.disabledReason}
      >
        <MenuIcon name={item.icon} />
        <span className="file-menu-label">{item.label}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
        {item.children && <span className="file-menu-arrow" aria-hidden="true">›</span>}
        {item.disabledReason && <span id={`file-menu-reason-${item.id}`} className="visually-hidden">{item.disabledReason}</span>}
      </button>
    </li>
  );

  return (
    <div className="file-menu-root" ref={rootRef} onKeyDown={onMenuKeyDown}>
      <button
        ref={triggerRef}
        className={`ribbon-tab file-menu-trigger${open ? " active" : ""}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) close(true);
          else {
            setOpen(true);
            requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>("[data-menu-list='root'] button:not(:disabled)")?.focus());
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSubmenuPosition(null);
            setOpen(true);
            requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>("[data-menu-list='root'] button:not(:disabled)")?.focus());
          }
        }}
      >파일</button>
      {open && (
        <div className="file-menu-panel" role="presentation">
          <ul role="menu" data-menu-list="root">
            {items.map((entry) => isSeparator(entry)
              ? <li key={entry.id} className="file-menu-separator" role="separator" />
              : renderItem(entry))}
          </ul>
        </div>
      )}
      {open && activeSubmenu?.children && createPortal(
        <div
          className="file-menu-submenu"
          ref={submenuRef}
          style={{
            left: submenuPosition?.left ?? 0,
            top: submenuPosition?.top ?? 0,
            visibility: submenuPosition?.ready ? "visible" : "hidden",
          }}
          onKeyDown={onMenuKeyDown}
        >
          <ul role="menu" data-menu-list="submenu" data-parent-id={activeSubmenu.id}>
            {activeSubmenu.children.map((child) => renderItem(child))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}

