/** 从 `姓名 <a@b.com>` / `a@b.com` 中取出裸地址（小写，便于比较） */
export function extractEmailAddress(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const bracketed = value.match(/<([^>]+)>/);
  const email = bracketed ? bracketed[1] : value;
  return email.trim().toLowerCase();
}

/**
 * 去掉自己与重复收件人，保持原有顺序。
 *
 * 原邮件里的地址是 `姓名 <地址>` 形式，直接和 `account.fromAddress`（裸地址）做字符串比较
 * 永远不相等，会导致「回复全部」把自己也加进收件人/抄送。
 */
export function excludeSelf(
  addresses: string[],
  selfAddress?: string | null,
): string[] {
  const self = extractEmailAddress(selfAddress);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const addr of addresses) {
    const email = extractEmailAddress(addr);
    if (!email) continue;
    if (self && email === self) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    result.push(addr.trim());
  }
  return result;
}
