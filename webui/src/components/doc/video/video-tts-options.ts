import { EDGE_TTS_VOICES } from "@/lib/constants";

export type TtsProvider = "edge" | "custom";

export const TTS_PROVIDERS: Array<{
  value: TtsProvider;
  label: string;
  hint: string;
}> = [
  { value: "edge", label: "内置配音", hint: "无需额外配置" },
  { value: "custom", label: "我的语音服务", hint: "使用设置中的默认音色" },
];

/** 语速选项（百分比），默认 0 表示正常语速。 */
export const TTS_RATE_OPTIONS = [
  { value: "+0%", label: "正常" },
  { value: "+10%", label: "稍快 (+10%)" },
  { value: "+20%", label: "较快 (+20%)" },
  { value: "+30%", label: "很快 (+30%)" },
  { value: "-10%", label: "稍慢 (-10%)" },
  { value: "-20%", label: "较慢 (-20%)" },
  { value: "-30%", label: "很慢 (-30%)" },
] as const;

export { EDGE_TTS_VOICES };
