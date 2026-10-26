import { describe, expect, it } from "vitest";
import { excludeSelf, extractEmailAddress } from "./addressUtils";

describe("extractEmailAddress", () => {
  it("从带姓名的地址里取出裸地址并转小写", () => {
    expect(extractEmailAddress("刘喆 <LiuZhe@OS-Easy.com>")).toBe("liuzhe@os-easy.com");
    expect(extractEmailAddress("liuzhe@os-easy.com")).toBe("liuzhe@os-easy.com");
    expect(extractEmailAddress("  张惠 < zhanghui@os-easy.com >  ")).toBe("zhanghui@os-easy.com");
  });

  it("空值返回空串", () => {
    expect(extractEmailAddress("")).toBe("");
    expect(extractEmailAddress(null)).toBe("");
    expect(extractEmailAddress(undefined)).toBe("");
  });
});

describe("excludeSelf", () => {
  const self = "liuzhe@os-easy.com";

  it("回复全部时把自己从收件人里剔除（带姓名的写法也要剔除）", () => {
    expect(
      excludeSelf(["刘喆 <liuzhe@os-easy.com>", "王梦雄 <wangmengxiong@os-easy.com>"], self),
    ).toEqual(["王梦雄 <wangmengxiong@os-easy.com>"]);
  });

  it("大小写不同也视为自己", () => {
    expect(excludeSelf(["LIUZHE@os-easy.com", "a@b.com"], self)).toEqual(["a@b.com"]);
  });

  it("去重并保持原顺序", () => {
    expect(
      excludeSelf(
        ["A <a@b.com>", "a@b.com", "B <b@c.com>", "A2 <A@B.com>"],
        self,
      ),
    ).toEqual(["A <a@b.com>", "B <b@c.com>"]);
  });

  it("没有 self 时只去重", () => {
    expect(excludeSelf(["a@b.com", "a@b.com"], null)).toEqual(["a@b.com"]);
  });
});
