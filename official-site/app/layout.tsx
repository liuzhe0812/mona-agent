import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mona — 真正的 Work Buddy",
  description:
    "Mona 把邮件、日程、笔记、浏览器、终端和数据库带进同一个 AI 工作桌面。",
  icons: {
    icon: "/img/mona-logo.png",
    shortcut: "/img/mona-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
