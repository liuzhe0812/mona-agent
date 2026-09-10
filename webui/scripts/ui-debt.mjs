#!/usr/bin/env node
/**
 * UI 债务扫描与增量检查（mona-ui-refactor-plan UI-01B / UI-01C）
 *
 * 用法：
 *   node scripts/ui-debt.mjs scan      全量扫描并打印汇总（不写文件）
 *   node scripts/ui-debt.mjs baseline  以当前扫描结果更新 scripts/ui-debt-baseline.json
 *   node scripts/ui-debt.mjs check     与基线对比，发现新增债务时 exit 1
 *
 * 债务类别（对应设计规范 §19.2 禁止项）：
 *   arbitrary-text    任意字号 text-[…]
 *   hex-color         业务 UI 中的十六进制产品色
 *   native-button     原生 <button>（语义按钮应使用共享 Button）
 *   native-input      原生 <input>
 *   native-select     原生 <select>
 *   native-textarea   原生 <textarea>
 *   arbitrary-radius  任意圆角 rounded-[…]
 *   arbitrary-shadow  任意阴影 shadow-[…]
 *
 * 白名单只用于真实特殊区域（refactor-plan §3.3），禁止为掩盖债务而扩大。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BASELINE_PATH = join(ROOT, "scripts", "ui-debt-baseline.json");

const CATEGORIES = {
  "arbitrary-text": /\btext-\[(?:length:)?[^\]\s]+\]/g,
  "hex-color":
    /(?<!url\()(?<!href=["'])(?<!xlink:href=["'])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g,
  "native-button": /<button[\s>]/g,
  "native-input": /<input[\s>]/g,
  "native-select": /<select[\s>]/g,
  "native-textarea": /<textarea[\s>]/g,
  "arbitrary-radius": /\brounded-\[[^\]]+\]/g,
  "arbitrary-shadow": /\bshadow-\[[^\]]+\]/g,
};

/** 不参与扫描的文件（测试、类型声明、Token 定义处） */
const EXCLUDE_FILE = [
  /\.(test|spec)\.[tj]sx?$/,
  /\.d\.ts$/,
  /(^|[\\/])globals\.css$/,
];

/** 路径白名单：只覆盖 refactor-plan §3.3 定义的真实特殊区域 */
const ALLOWLIST = [
  {
    path: "src/components/terminal/Desktop",
    categories: "*",
    reason: "终端虚拟桌面例外",
  },
  {
    path: "src/components/terminal/XtermTerminal.tsx",
    categories: ["hex-color"],
    reason: "xterm ANSI 主题色",
  },
  {
    path: "src/components/terminal/VncViewer.tsx",
    categories: ["hex-color"],
    reason: "VNC 画面配色",
  },
  {
    path: "src/components/profile/charts",
    categories: ["hex-color"],
    reason: "数据可视化色板（规范 §4.5）",
  },
  {
    path: "src/components/profile/profile-theme.ts",
    categories: ["hex-color"],
    reason: "画像色板定义",
  },
  {
    path: "src/components/profile/ProfileStyles.tsx",
    categories: ["hex-color"],
    reason: "画像可视化样式",
  },
  {
    path: "src/components/notes/flowchart",
    categories: ["hex-color"],
    reason: "流程图画布文档主题",
  },
  {
    path: "src/components/notes/mindmap",
    categories: ["hex-color"],
    reason: "思维导图画布主题",
  },
  {
    path: "src/components/doc/video/style/SeriesStyleEditor.tsx",
    categories: ["hex-color", "native-input"],
    reason: "视频风格令牌编辑器的颜色值、范围滑杆与版本单选控件",
  },
  {
    path: "src/components/doc/video/ProducingPhase.tsx",
    categories: ["native-input"],
    reason: "场景精细时间轴的原生 range 播放头，保留键盘与无障碍语义",
  },
  {
    path: "src/lib/codemirror",
    categories: ["hex-color"],
    reason: "代码语法色",
  },
  {
    path: "src/components/common/editor-extensions",
    categories: ["hex-color"],
    reason: "编辑器内容扩展（mermaid/math）",
  },
  {
    path: "src/components/AgentLogo.tsx",
    categories: ["hex-color"],
    reason: "品牌 SVG 资源",
  },
];

const SCAN_EXT = new Set([".ts", ".tsx", ".css"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (SCAN_EXT.has(ext)) yield full;
    }
  }
}

function isExempt(relPath, category) {
  for (const rule of ALLOWLIST) {
    if (relPath === rule.path || relPath.startsWith(rule.path + "/")) {
      if (rule.categories === "*" || rule.categories.includes(category))
        return true;
    }
  }
  return false;
}

function scanAll() {
  /** @type {Record<string, Record<string, number>>} */
  const files = {};
  for (const full of walk(SRC)) {
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    if (EXCLUDE_FILE.some((re) => re.test(rel))) continue;
    const content = readFileSync(full, "utf8");
    /** @type {Record<string, number>} */
    const counts = {};
    for (const [category, re] of Object.entries(CATEGORIES)) {
      if (isExempt(rel, category)) continue;
      const matches = content.match(re);
      if (matches && matches.length > 0) counts[category] = matches.length;
    }
    if (Object.keys(counts).length > 0) files[rel] = counts;
  }
  return files;
}

function totals(files) {
  /** @type {Record<string, number>} */
  const sum = {};
  for (const counts of Object.values(files)) {
    for (const [k, v] of Object.entries(counts)) sum[k] = (sum[k] ?? 0) + v;
  }
  return sum;
}

function printTotals(files) {
  const sum = totals(files);
  const fileCount = Object.keys(files).length;
  console.log(`\nUI 债务汇总（${fileCount} 个文件含债务）：`);
  for (const category of Object.keys(CATEGORIES)) {
    console.log(`  ${category.padEnd(18)} ${sum[category] ?? 0}`);
  }
  const grand = Object.values(sum).reduce((a, b) => a + b, 0);
  console.log(`  ${"合计".padEnd(18)} ${grand}\n`);
}

function main() {
  const mode = process.argv[2] ?? "scan";
  const current = scanAll();

  if (mode === "scan") {
    printTotals(current);
    return;
  }

  if (mode === "baseline") {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      note: "UI 债务基线（UI-01B）。仅允许计数下降；迁移批次完成后用 `npm run check:ui:update` 更新。",
      files: current,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n");
    console.log(`基线已写入 ${relative(ROOT, BASELINE_PATH)}`);
    printTotals(current);
    return;
  }

  if (mode === "check") {
    if (!existsSync(BASELINE_PATH)) {
      console.error(
        "缺少基线文件 scripts/ui-debt-baseline.json，请先运行 `npm run check:ui:update`。",
      );
      process.exit(2);
    }
    const baseline =
      JSON.parse(readFileSync(BASELINE_PATH, "utf8")).files ?? {};
    /** @type {string[]} */
    const reports = [];
    for (const [file, counts] of Object.entries(current)) {
      const base = baseline[file] ?? {};
      const added = [];
      for (const [category, count] of Object.entries(counts)) {
        const before = base[category] ?? 0;
        if (count > before)
          added.push(`${category} +${count - before}（${before} → ${count}）`);
      }
      if (added.length > 0) reports.push(`  ${file}: ${added.join(", ")}`);
    }
    if (reports.length > 0) {
      console.error(`\n发现新增 UI 债务（${reports.length} 个文件）：`);
      for (const line of reports) console.error(line);
      console.error(
        "\n请使用语义 Token 与共享组件（docs/design/mona-ui-design-system.md §19.2）；",
        "\n确属特殊区域时，在 scripts/ui-debt.mjs 的 ALLOWLIST 中登记理由。",
      );
      process.exit(1);
    }
    const sum = totals(current);
    const grand = Object.values(sum).reduce((a, b) => a + b, 0);
    console.log(`✓ 无新增 UI 债务（当前存量 ${grand}，只许下降）`);
    return;
  }

  console.error(`未知模式：${mode}（可用：scan / baseline / check）`);
  process.exit(2);
}

main();
