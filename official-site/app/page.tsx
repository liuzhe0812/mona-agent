"use client";

import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

const menuItems = [
  { label: "快速入门", tag: "START", href: "#intro" },
  { label: "免费模型", tag: "FREE", href: "#models" },
  { label: "Agent", tag: "CORE", href: "#agent" },
  { label: "模块", tag: "MODULES", href: "#modules" },
  { label: "白盒运维", tag: "VISIBLE", href: "#whitebox" },
  { label: "桌面端", tag: "DESKTOP", href: "#desktop" },
  { label: "更新日志", tag: "CHANGELOG", href: "#changelog" },
] as const;

const dialogue = [
  "你以为 AI 助手，就是一个更聪明的聊天框？",
  "不。真正的搭档，不该等你把工作重新解释一遍。",
  "它应该和你待在同一个桌面，接住邮件、日程、笔记、浏览器、终端和数据库里的工作。",
  "每一次行动，都让工作沉淀成下一次可以继续使用的知识。",
  "不是回答完就离开。是陪你把事情做完。这才是 Work Buddy。",
] as const;

const chapters = [
  {
    id: "models",
    number: "01",
    eyebrow: "FREE MODEL",
    title: "从现在开始",
    copy: "用免费模型体验 Mona，先完成一件真实工作。",
  },
  {
    id: "agent",
    number: "02",
    eyebrow: "AGENT",
    title: "不只回答",
    copy: "让 AI 贯穿邮件、日程、笔记、浏览器、终端和数据库。",
  },
  {
    id: "modules",
    number: "03",
    eyebrow: "MODULES",
    title: "能力自由组合",
    copy: "把不同工作入口放进同一个桌面，而不是来回切换工具。",
  },
  {
    id: "whitebox",
    number: "04",
    eyebrow: "WHITE BOX",
    title: "过程保持可见",
    copy: "白盒运维让系统动作与状态回到用户视野。",
  },
  {
    id: "desktop",
    number: "05",
    eyebrow: "DESKTOP",
    title: "统一工作桌面",
    copy: "把分散的任务、工具和上下文收回一个地方。",
  },
  {
    id: "changelog",
    number: "06",
    eyebrow: "CHANGELOG",
    title: "持续进化",
    copy: "每一次更新都围绕更可靠、更完整的工作协作。",
  },
] as const;

const DOWNLOAD_URL = "https://dl.mona.lzfun.vip/Mona-latest.exe";

export default function Home() {
  const heroRef = useRef<HTMLElement>(null);
  const dialogueRef = useRef<HTMLElement>(null);
  const menuRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [activeMenu, setActiveMenu] = useState(0);
  const [dialogueIndex, setDialogueIndex] = useState(0);
  const [dialogueActive, setDialogueActive] = useState(false);

  useEffect(() => {
    const section = dialogueRef.current;
    if (!section) return;

    const observer = new IntersectionObserver(
      ([entry]) => setDialogueActive(entry.intersectionRatio >= 0.55),
      { threshold: [0.55] },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        if (dialogueActive) {
          setDialogueIndex((index) => (index + 1) % dialogue.length);
        } else {
          dialogueRef.current?.scrollIntoView({ behavior: "smooth" });
        }
        return;
      }

      if (dialogueActive) {
        if (event.key === "Escape") {
          heroRef.current?.scrollIntoView({ behavior: "smooth" });
        }
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const next =
          (activeMenu + offset + menuItems.length) % menuItems.length;
        setActiveMenu(next);
        menuRefs.current[next]?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeMenu, dialogueActive]);

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (
      event.pointerType !== "mouse" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * -14;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * -9;
    event.currentTarget.style.setProperty("--scene-x", `${x}px`);
    event.currentTarget.style.setProperty("--scene-y", `${y}px`);
  };

  return (
    <>
      <a className="skip-link" href="#intro">
        跳到产品介绍
      </a>

      <main>
        <section
          ref={heroRef}
          className="hero"
          aria-labelledby="hero-title"
          onPointerMove={handlePointerMove}
        >
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-shade" aria-hidden="true" />
          <div className="print-noise" aria-hidden="true" />

          <header className="brand">
            <img src="/img/mona-logo.png" alt="" />
            <div>
              <strong>MONA</strong>
              <span>ONLINE</span>
            </div>
          </header>

          <div className="hero-copy">
            <span className="chapter-label">CHAPTER 00 / WAKE UP</span>
            <h1 id="hero-title">
              工作，<br />
              不该从<br />
              <span style={{ whiteSpace: "nowrap" }}>
                <em>重新解释</em>开始。
              </span>
            </h1>
          </div>

          <nav className="game-menu" aria-label="主菜单">
            <span className="menu-title">SELECT MISSION</span>
            {menuItems.map((item, index) => (
              <a
                key={item.label}
                ref={(node) => {
                  menuRefs.current[index] = node;
                }}
                className={index === activeMenu ? "is-active" : ""}
                href={item.href}
                style={{ "--index": index } as CSSProperties}
                onFocus={() => setActiveMenu(index)}
                onPointerEnter={() => setActiveMenu(index)}
              >
                <span className="menu-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <strong>{item.label}</strong>
                <small>{item.tag}</small>
              </a>
            ))}

            <a className="download-cta" href={DOWNLOAD_URL}>
              下载 Mona <span>↗</span>
            </a>
          </nav>

          <div className="hero-status" aria-hidden="true">
            <span>RAIN / 02:17 AM</span>
            <span>MONA IS WATCHING</span>
          </div>

          <a className="continue-hint" href="#intro">
            <kbd>SPACE</kbd>
            <span>对话Mona</span>
          </a>
        </section>

        <section
          ref={dialogueRef}
          id="intro"
          className="dialogue-scene"
          aria-labelledby="dialogue-heading"
        >
          <div className="dialogue-art" aria-hidden="true" />
          <div className="dialogue-wash" aria-hidden="true" />

          <div className="dialogue-heading">
            <span>CASE FILE / 001</span>
            <h2 id="dialogue-heading">什么是真正的 Work&nbsp;Buddy？</h2>
          </div>

          <div className="dialogue-portrait" aria-hidden="true">
            <img src="/img/mona-logo.png" alt="" />
          </div>

          <div className="dialogue-panel">
            <span className="speaker">MONA</span>
            <button
              className="dialogue-box"
              type="button"
              aria-label="下一页对话"
              onClick={() =>
                setDialogueIndex((index) => (index + 1) % dialogue.length)
              }
            >
              <span className="dialogue-copy" aria-live="polite">
                {dialogue[dialogueIndex]}
              </span>
              <span className="dialogue-progress">
                {String(dialogueIndex + 1).padStart(2, "0")} /{" "}
                {String(dialogue.length).padStart(2, "0")}
              </span>
              <span className="dialogue-next">SPACE / CLICK ↗</span>
            </button>
          </div>
        </section>

        <section
          id="chapters"
          className="mission-board"
          aria-labelledby="chapters-heading"
        >
          <header>
            <span>FIELD GUIDE / MONA SYSTEM</span>
            <h2 id="chapters-heading">进入 Mona 的工作现场</h2>
          </header>

          <div className="mission-grid">
            {chapters.map((chapter) => (
              <article id={chapter.id} key={chapter.id}>
                <span className="mission-number">{chapter.number}</span>
                <small>{chapter.eyebrow}</small>
                <h3>{chapter.title}</h3>
                <p>{chapter.copy}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
