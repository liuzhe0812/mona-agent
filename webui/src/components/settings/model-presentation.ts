import alibabaIcon from "@lobehub/icons-static-svg/icons/alibaba.svg";
import agnesIcon from "@lobehub/icons-static-svg/icons/agnesai.svg";
import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import bytedanceIcon from "@lobehub/icons-static-svg/icons/doubao.svg";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini.svg";
import miniMaxIcon from "@lobehub/icons-static-svg/icons/minimax.svg";
import moonshotIcon from "@lobehub/icons-static-svg/icons/kimi.svg";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu.svg";

type ModelBrand = {
  id: string;
  label: string;
  aliases: string[];
  namePrefix: string;
  icon: string;
};

const MODEL_BRANDS: ModelBrand[] = [
  { id: "deepseek", label: "深度求索", aliases: ["deepseek"], namePrefix: "DeepSeek", icon: deepseekIcon },
  { id: "zhipu", label: "智谱", aliases: ["glm", "zhipu"], namePrefix: "GLM", icon: zhipuIcon },
  { id: "moonshot", label: "月之暗面", aliases: ["kimi", "moonshot"], namePrefix: "Kimi", icon: moonshotIcon },
  { id: "alibaba", label: "阿里巴巴", aliases: ["qwen", "alibaba", "alibabacloud"], namePrefix: "Qwen", icon: alibabaIcon },
  { id: "bytedance", label: "字节跳动", aliases: ["doubao", "seed", "bytedance"], namePrefix: "Doubao", icon: bytedanceIcon },
  { id: "openai", label: "OpenAI", aliases: ["gpt", "openai"], namePrefix: "GPT", icon: openaiIcon },
  { id: "anthropic", label: "Anthropic", aliases: ["claude", "anthropic"], namePrefix: "Claude", icon: anthropicIcon },
  { id: "google", label: "Google", aliases: ["gemini", "google"], namePrefix: "Gemini", icon: geminiIcon },
  { id: "minimax", label: "MiniMax", aliases: ["minimax"], namePrefix: "MiniMax", icon: miniMaxIcon },
  { id: "agnes", label: "Agnes", aliases: ["agnes", "agnesai"], namePrefix: "Agnes", icon: agnesIcon },
];

function findBrand(id: string): { brand: ModelBrand; alias: string; namespace: boolean } | undefined {
  const normalized = id.toLowerCase();
  const namespace = normalized.match(/^([^/:]+)[/:]/)?.[1];
  if (namespace) {
    const brand = MODEL_BRANDS.find((candidate) => candidate.aliases.includes(namespace));
    if (brand) return { brand, alias: namespace, namespace: true };
  }

  for (const brand of MODEL_BRANDS) {
    const alias = brand.aliases.find((candidate) => {
      if (candidate === "qwen") return new RegExp(`^${candidate}(?:[-_.]|\\d|$)`, "i").test(id);
      return new RegExp(`^${candidate}(?:[-_.]|$)`, "i").test(id);
    });
    if (alias) return { brand, alias, namespace: false };
  }

  if (/^o[1-9](?:[-_.]|$)/i.test(id)) {
    const brand = MODEL_BRANDS.find((candidate) => candidate.id === "openai")!;
    return { brand, alias: "", namespace: false };
  }
  return undefined;
}

function readableModelName(id: string, match: NonNullable<ReturnType<typeof findBrand>>): string {
  let name = id;
  if (match.namespace) name = id.slice(match.alias.length + 1);
  const familyAlias = match.brand.aliases.find((alias) => {
    if (alias === "qwen") return new RegExp(`^${alias}(?=[-_.]|\\d)`, "i").test(name);
    return new RegExp(`^${alias}[-_.]`, "i").test(name);
  });
  if (familyAlias) {
    const suffix = name.slice(familyAlias.length).replace(/^[-_.]/, "");
    const prefix = familyName(match.brand.id, familyAlias);
    return `${prefix} ${formatModelTokens(suffix, familyAlias)}`.trim();
  }

  const oSeries = match.brand.id === "openai" && name.match(/^o([1-9])(?:[-_.](.+))?$/i);
  if (oSeries) return `o${oSeries[1]}${oSeries[2] ? ` ${formatModelTokens(oSeries[2])}` : ""}`;
  return formatModelTokens(name);
}

function familyName(brandId: string, alias: string): string {
  if (brandId === "moonshot" && alias === "moonshot") return "Moonshot";
  if (brandId === "bytedance" && alias === "seed") return "Seed";
  if (brandId === "openai" && alias === "openai") return "OpenAI";
  return MODEL_BRANDS.find((brand) => brand.id === brandId)?.namePrefix ?? alias;
}

function formatModelTokens(value: string, familyAlias?: string): string {
  const suffix = familyAlias === "claude" ? value.replace(/^(\d+)-(\d+)(?=-|$)/, "$1.$2") : value;
  const dates: string[] = [];
  const withDatePlaceholders = suffix.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (date) => {
    dates.push(date);
    return `zzdate${dates.length - 1}zz`;
  });
  return withDatePlaceholders
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const dateIndex = token.match(/^zzdate(\d+)zz$/i)?.[1];
      if (dateIndex !== undefined) return dates[Number(dateIndex)];
      if (/^o\d+$/i.test(token)) return token.toLowerCase();
      if (/^[rv]\d/i.test(token)) return `${token[0].toUpperCase()}${token.slice(1)}`;
      if (/^\d/.test(token)) return token;
      return `${token[0].toUpperCase()}${token.slice(1)}`;
    })
    .join(" ");
}

export function modelPresentation(
  model: { id: string; name: string },
  fallback: { id: string; label: string },
): { brandId: string; brandLabel: string; name: string; icon?: string } {
  const match = findBrand(model.id);
  if (!match) return { brandId: fallback.id, brandLabel: fallback.label, name: model.name };

  return {
    brandId: match.brand.id,
    brandLabel: match.brand.label,
    name: model.name === model.id ? readableModelName(model.id, match) : model.name,
    icon: match.brand.icon,
  };
}
