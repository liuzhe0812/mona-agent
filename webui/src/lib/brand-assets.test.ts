import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MONA_BRAND_AVATAR, MONA_BRAND_ICON, MONA_PROVIDER_ICON, resolveMonaAvatarUrl } from "./brand-assets";

describe("Mona logos remain separate from portraits", () => {
  it("uses the approved hand-free PNG portrait without changing the logo revision", () => {
    expect(MONA_BRAND_AVATAR).toBe("/brand/mona-default-avatar.png?v=3932b58cd98c");
    expect(MONA_BRAND_AVATAR).not.toBe(MONA_BRAND_ICON);
    expect(MONA_BRAND_ICON).toBe("/brand/mona_app_icon.png?v=a829e97b8751");
    expect(MONA_PROVIDER_ICON).toBe("/brand/mona_icon.png?v=a829e97b8751");
  });
  it("ships the approved PNG bytes behind the avatar content revision", () => {
    const pathname = MONA_BRAND_AVATAR.split("?")[0];
    const bytes = readFileSync(resolve(process.cwd(), "public", pathname.slice(1)));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(sha256).toBe("3932b58cd98c7f51bba57b8e2ae797aab1a738f72f9df95d9287629ba343f753");
    expect(MONA_BRAND_AVATAR).toContain(`?v=${sha256.slice(0, 12)}`);
  });
  it.each([undefined, null, "", "/brand/mona_avatar_human.png", "/brand/mona_avatar_human.png?v=old", "/brand/v2/avatar.webp", "/brand/v2/avatar.webp?v=8f12d953a395", "/brand/v2/avatar.webp#preview"])("updates an empty or former built-in portrait: %s", (source) => {
    expect(resolveMonaAvatarUrl(source)).toBe(MONA_BRAND_AVATAR);
  });
  it.each([MONA_BRAND_AVATAR, "/brand/mona_avatar_white.png", "/brand/mona_app_icon.png", "https://example.com/my-avatar.png", "https://example.com/brand/v2/avatar.webp", "/user/avatar.png", "/user/brand/v2/avatar.webp", "/brand/v2/avatar.webp.custom.png", "data:image/png;base64,custom"])("preserves an explicitly selected avatar: %s", (source) => {
    expect(resolveMonaAvatarUrl(source)).toBe(source);
  });
});
