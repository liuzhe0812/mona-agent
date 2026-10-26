import type { EmailMessage } from "./types";

/**
 * 转发/回复时构造「原始邮件」引用块。
 *
 * 关键约束：原邮件正文必须原样保留，不能交给富文本编辑器重建。
 * 编辑器（Tiptap）只有 p/b/i/list 等有限 schema，一旦把原 HTML 塞进编辑器，
 * 标题（h1~h6）、表格、内联样式、<style> 块全部会被 schema 丢弃，
 * 收件人看到的就是被压平过的纯文本。因此引用块以字符串形式独立保存：
 * - 编辑区只承载用户新写的内容；
 * - 引用块只读展示，发送时原样拼接到正文末尾。
 */

/** 企业微信风格：引用头部统一灰色小字 */
const META_STYLE = "margin:0;color:#909399;font-size:12px;line-height:20px;";

const QUOTE_FONT_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 2016年10月20日 周二 17:06（与企业微信一致的时间展示） */
export function formatQuoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAddress(name: string | null | undefined, address: string): string {
  const n = (name ?? "").trim();
  const a = (address ?? "").trim();
  if (n && a) return `${n} <${a}>`;
  return n || a;
}

function textToQuoteHtml(text: string): string {
  return escapeHtml(text)
    .split("\n")
    .map((line) => (line.trim() === "" ? "<br>" : line))
    .join("<br>");
}

/**
 * 取出原邮件正文 HTML，保留其结构和样式：
 * - 把 <head> 里的 <style> 提到正文前面（邮件模板常把样式放在 head，直接丢掉会掉版）；
 * - 保留 <body> 上的 style/背景色；
 * - 去掉 script（引用内容不需要脚本，避免带进外发邮件）。
 */
export function extractQuotedBodyHtml(message: EmailMessage): string {
  const raw = (message.bodyHtml ?? "").trim();
  if (raw) {
    const styles = Array.from(raw.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi))
      .map((m) => m[0])
      .join("");
    const bodyMatch = raw.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
    const bodyStyle = bodyMatch?.[1]?.match(/style\s*=\s*"([^"]*)"/i)?.[1] ?? "";
    let body = bodyMatch
      ? bodyMatch[2]
      : raw
          .replace(/<!DOCTYPE[^>]*>/gi, "")
          .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
          .replace(/<\/?html[^>]*>/gi, "");
    body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    // head 里的 style 已单独提取，正文中重复的 style 去重
    const bodyWithoutHeadStyles = body.replace(
      /<style[^>]*>[\s\S]*?<\/style>/gi,
      "",
    );
    const wrapperStyle = bodyStyle ? ` style="${bodyStyle}"` : "";
    return `<div${wrapperStyle}>${styles}${bodyWithoutHeadStyles}</div>`;
  }
  if (message.bodyText) {
    return `<div style="${QUOTE_FONT_STYLE}">${textToQuoteHtml(message.bodyText)}</div>`;
  }
  return "";
}

/** 引用头部：发件人 / 日期 / 收件人 / 抄送 / 主题（顺序与企业微信一致） */
export function buildQuoteHeaderHtml(message: EmailMessage): string {
  const lines: string[] = [`-------- 原始邮件 --------`];
  lines.push(`发件人：${formatAddress(message.fromName, message.fromAddress)}`);
  const date = formatQuoteDate(message.date);
  if (date) lines.push(`日期：${date}`);
  if (message.toAddresses?.trim()) {
    lines.push(`收件人：${message.toAddresses.trim()}`);
  }
  if (message.ccAddresses?.trim()) {
    lines.push(`抄送人：${message.ccAddresses.trim()}`);
  }
  lines.push(`主题：${message.subject || "(无主题)"}`);
  return lines
    .map((line) => `<div style="${META_STYLE}">${escapeHtml(line)}</div>`)
    .join("");
}

/** 完整的引用块（头部 + 原正文），发送时原样拼在正文末尾 */
export function buildQuotedMailHtml(message: EmailMessage): string {
  const header = buildQuoteHeaderHtml(message);
  const body = extractQuotedBodyHtml(message);
  return [
    `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;${QUOTE_FONT_STYLE}">`,
    header,
    "</div>",
    body ? `<div style="margin-top:12px;${QUOTE_FONT_STYLE}">${body}</div>` : "",
  ].join("");
}

/** 转发主题：识别已有的 Fwd:/Fw:/转发: 前缀，避免重复叠加 */
export function buildForwardSubject(original: string): string {
  const subject = (original ?? "").trim();
  if (!subject) return "Fwd:";
  if (/^\s*(fwd?|转发)\s*[:：]/i.test(subject)) return subject;
  return `Fwd: ${subject}`;
}
