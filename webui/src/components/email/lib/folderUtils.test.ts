import { describe, expect, it } from "vitest";
import { getFolderUnreadCount, isSentFolder, isUnreadMessage } from "./folderUtils";

describe("isSentFolder", () => {
  it("识别常见的已发送文件夹命名", () => {
    expect(isSentFolder("Sent")).toBe(true);
    expect(isSentFolder("Sent Messages")).toBe(true);
    expect(isSentFolder("Sent Items")).toBe(true);
    expect(isSentFolder("[Gmail]/Sent Mail")).toBe(true);
    expect(isSentFolder("已发送")).toBe(true);
    expect(isSentFolder("已发邮件")).toBe(true);
  });

  it("不收件箱、草稿等文件夹误判为已发送", () => {
    expect(isSentFolder("INBOX")).toBe(false);
    expect(isSentFolder("Drafts")).toBe(false);
    expect(isSentFolder("Trash")).toBe(false);
    expect(isSentFolder("")).toBe(false);
  });
});

describe("isUnreadMessage", () => {
  it("已发送文件夹的邮件不视为未读", () => {
    expect(isUnreadMessage({ isRead: false, folder: "Sent Messages" })).toBe(false);
  });

  it("收件箱的未读邮件仍视为未读", () => {
    expect(isUnreadMessage({ isRead: false, folder: "INBOX" })).toBe(true);
    expect(isUnreadMessage({ isRead: true, folder: "INBOX" })).toBe(false);
  });
});

describe("getFolderUnreadCount", () => {
  it("已发送文件夹未读数恒为 0", () => {
    expect(getFolderUnreadCount("已发送", { 已发送: 7 })).toBe(0);
  });

  it("其他文件夹透传数据库未读数", () => {
    expect(getFolderUnreadCount("INBOX", { INBOX: 3 })).toBe(3);
    expect(getFolderUnreadCount("Drafts", {})).toBe(0);
  });
});
