import { describe, expect, it } from "vitest";
import {
  buildForwardSubject,
  buildQuoteHeaderHtml,
  buildQuotedMailHtml,
  extractQuotedBodyHtml,
} from "./quoteHtml";
import type { EmailMessage } from "./types";

const baseMessage = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  uid: "42",
  accountId: "account-a",
  folder: "INBOX",
  subject: "运维智能体0.1.2测试包",
  fromAddress: "liuzhe@os-easy.com",
  fromName: "刘喆",
  toAddresses: "曾丽星 <zlxing@os-easy.com>, 王梦雄 <wangmengxiong@os-easy.com>",
  ccAddresses: "张惠 <zhanghui@os-easy.com>",
  date: "2026-10-20T09:06:00.000Z",
  bodyText: "",
  hasAttachments: true,
  isRead: true,
  isStarred: false,
  rawSize: 1024,
  ...overrides,
});

describe("extractQuotedBodyHtml", () => {
  it("保留原邮件的标题、表格、内联样式和 head 里的 style 块", () => {
    const html = `<!DOCTYPE html><html><head>
      <style>.brand { color: #e0202b; }</style>
    </head><body style="background:#f7f8fa">
      <h2 style="font-size:20px">v0.1.2 (2026-10-20)</h2>
      <p><strong>新功能</strong></p>
      <ul><li>支持引用对话中的文字</li></ul>
      <table><tr><td style="padding:4px">单元格</td></tr></table>
    </body></html>`;

    const result = extractQuotedBodyHtml(baseMessage({ bodyHtml: html }));

    expect(result).toContain("<h2");
    expect(result).toContain(".brand { color: #e0202b; }");
    expect(result).toContain("<table>");
    expect(result).toContain('style="padding:4px"');
    expect(result).toContain("background:#f7f8fa");
    // 外壳标签不应该出现在正文片段里
    expect(result).not.toContain("<html");
    expect(result).not.toContain("<body");
  });

  it("剔除脚本，避免引用内容带进外发邮件", () => {
    const result = extractQuotedBodyHtml(
      baseMessage({ bodyHtml: "<p>正文</p><script>alert(1)</script>" }),
    );
    expect(result).toContain("正文");
    expect(result).not.toContain("script");
  });

  it("没有 HTML 正文时退回纯文本并保留换行", () => {
    const result = extractQuotedBodyHtml(
      baseMessage({ bodyHtml: null, bodyText: "第一行\n第二行" }),
    );
    expect(result).toContain("第一行<br>第二行");
  });
});

describe("buildQuoteHeaderHtml", () => {
  it("按发件人、日期、收件人、抄送人、主题顺序输出灰色小字", () => {
    const html = buildQuoteHeaderHtml(baseMessage());
    const order = ["-------- 原始邮件 --------", "发件人：", "日期：", "收件人：", "抄送人：", "主题："];
    const positions = order.map((token) => html.indexOf(token));
    positions.forEach((pos, i) => {
      expect(pos, `缺少 ${order[i]}`).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(pos).toBeGreaterThan(positions[i - 1]);
    });
    expect(html).toContain("color:#909399");
    expect(html).toContain("刘喆 &lt;liuzhe@os-easy.com&gt;");
  });

  it("转义主题里的尖括号，避免破坏结构", () => {
    const html = buildQuoteHeaderHtml(baseMessage({ subject: "<b>危险</b>" }));
    expect(html).toContain("&lt;b&gt;危险&lt;/b&gt;");
    expect(html).not.toContain("<b>危险</b>");
  });

  it("没有抄送时不输出抄送行", () => {
    const html = buildQuoteHeaderHtml(baseMessage({ ccAddresses: null }));
    expect(html).not.toContain("抄送人：");
  });
});

describe("buildQuotedMailHtml", () => {
  it("引用块同时包含头部和原邮件正文格式", () => {
    const html = buildQuotedMailHtml(
      baseMessage({ bodyHtml: "<h2>原始标题</h2><p style=\"color:#333\">原文</p>" }),
    );
    expect(html).toContain("-------- 原始邮件 --------");
    expect(html).toContain("<h2>原始标题</h2>");
    expect(html).toContain('style="color:#333"');
  });
});

describe("buildForwardSubject", () => {
  it("没有前缀时添加 Fwd:", () => {
    expect(buildForwardSubject("运维智能体0.1.2测试包")).toBe("Fwd: 运维智能体0.1.2测试包");
  });

  it("已有 Fwd/FW/Fw/转发 前缀时不再叠加", () => {
    expect(buildForwardSubject("Fwd: 测试")).toBe("Fwd: 测试");
    expect(buildForwardSubject("FW: 测试")).toBe("FW: 测试");
    expect(buildForwardSubject("Fw：测试")).toBe("Fw：测试");
    expect(buildForwardSubject("转发: 测试")).toBe("转发: 测试");
  });

  it("空主题只给前缀", () => {
    expect(buildForwardSubject("")).toBe("Fwd:");
  });
});
