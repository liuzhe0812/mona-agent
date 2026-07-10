import { useEffect } from "react";

import { PROFILE_ANIMATIONS, PROFILE_CSS_VARS } from "./profile-theme";

let injected = false;

/** 注入画像页面的全局样式（CSS 变量 + 关键帧动画）。 */
export function ProfileStyles() {
  useEffect(() => {
    if (injected) return;
    injected = true;
    const style = document.createElement("style");
    style.setAttribute("data-profile-styles", "true");
    style.textContent = `${PROFILE_CSS_VARS}\n${PROFILE_ANIMATIONS}`;
    document.head.appendChild(style);
    return () => {
      injected = false;
      style.remove();
    };
  }, []);
  return null;
}
