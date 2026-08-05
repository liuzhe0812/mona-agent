import { useEffect, useState, useCallback, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { SlashMenu, type SlashMenuRef } from "./slash-menu";
import { setMenuKeyDownHandler } from "./index";

interface MenuState {
  visible: boolean;
  editor: Editor | null;
  clientRect: DOMRect | null;
  query: string;
}

const MENU_MAX_HEIGHT = 288;
const MENU_WIDTH = 320;
const MARGIN = 8;

function calculateMenuPosition(clientRect: DOMRect): { top: number; left: number } {
  let top = clientRect.bottom + MARGIN;
  let left = clientRect.left;

  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const menuWidth = Math.min(MENU_WIDTH, viewportWidth - MARGIN * 2);

  const availableHeightBelow = viewportHeight - clientRect.bottom - MARGIN;
  const availableHeightAbove = clientRect.top - MARGIN;

  if (availableHeightBelow < MENU_MAX_HEIGHT && availableHeightAbove > availableHeightBelow) {
    top = clientRect.top - MENU_MAX_HEIGHT - MARGIN;
  }

  top = Math.max(MARGIN, top);

  if (left + menuWidth > viewportWidth - MARGIN) {
    left = viewportWidth - menuWidth - MARGIN;
  }

  left = Math.max(MARGIN, left);

  return { top, left };
}

export const SlashCommandPortal = () => {
  const [state, setState] = useState<MenuState>({
    visible: false,
    editor: null,
    clientRect: null,
    query: "",
  });
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<SlashMenuRef>(null);

  const hideMenu = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
    setPosition(null);
  }, []);

  useEffect(() => {
    const showHandler = (e: Event) => {
      const event = e as CustomEvent<{ editor: Editor; clientRect: DOMRect; query: string }>;
      setPosition(calculateMenuPosition(event.detail.clientRect));
      setState({
        visible: true,
        editor: event.detail.editor,
        clientRect: event.detail.clientRect,
        query: event.detail.query,
      });
    };

    const updateHandler = (e: Event) => {
      const event = e as CustomEvent<{ clientRect: DOMRect; query: string }>;
      setPosition(calculateMenuPosition(event.detail.clientRect));
      setState((prev) => ({
        ...prev,
        clientRect: event.detail.clientRect,
        query: event.detail.query,
      }));
    };

    const hideHandler = () => hideMenu();

    document.addEventListener("slash-command-show", showHandler);
    document.addEventListener("slash-command-update", updateHandler);
    document.addEventListener("slash-command-hide", hideHandler);

    return () => {
      document.removeEventListener("slash-command-show", showHandler);
      document.removeEventListener("slash-command-update", updateHandler);
      document.removeEventListener("slash-command-hide", hideHandler);
    };
  }, [hideMenu]);

  // 注册键盘处理器
  useEffect(() => {
    if (state.visible && menuRef.current) {
      const handler = (props: { event: KeyboardEvent }) => {
        return menuRef.current?.onKeyDown?.(props) ?? false;
      };
      setMenuKeyDownHandler(handler);
      return () => {
        setMenuKeyDownHandler(null);
      };
    }
  }, [state.visible]);

  if (!state.visible || !state.editor || !position) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        zIndex: 9999,
      }}
    >
      <SlashMenu
        ref={menuRef}
        editor={state.editor}
        clientRect={state.clientRect}
        query={state.query}
      />
    </div>
  );
};

SlashCommandPortal.displayName = "SlashCommandPortal";

export default SlashCommandPortal;
