/**
 * 生成的 TypeScript 模型代码 → 浏览器可执行 JS。
 *
 * 使用 TypeScript 的 transpileModule（纯转译，不做类型检查）。
 * 预览与导出共用同一份编译结果，保证「所见即所导出」。
 *
 * 沙箱 import map 仅映射 "three"，生成器产出的 three/examples/jsm/* import
 *（RoomEnvironment、EffectComposer 等）无法在沙箱中解析。这些模块仅被
 * environment/postprocessing 辅助函数使用，沙箱只调用 create<Name>Model
 * 工厂函数，因此编译期安全地剥离这些 import 并 stub 标识符。
 */

import ts from "typescript";

/** 匹配 import { A, B as C } from 'three/examples/jsm/...' 或 import * as X from 'three/examples/jsm/...' */
const THREE_EXAMPLES_IMPORT_RE =
  /^\s*import\s+(?:type\s+)?(?:\*\s*as\s+(\w+)|\{([^}]*)\})\s+from\s+['"]three\/examples\/[^'"]+['"];?\s*$/gm;

/** 提取 three/examples/jsm/* import 中的标识符名称 */
function extractStrippedNames(source: string): { names: string[]; stripped: string } {
  const names: string[] = [];
  const stripped = source.replace(THREE_EXAMPLES_IMPORT_RE, (_match, namespace, named) => {
    if (namespace) {
      names.push(namespace);
    } else if (named) {
      for (const part of named.split(",")) {
        const trimmed = part.trim().split(/\s+as\s+/)[0].trim();
        if (trimmed) names.push(trimmed);
      }
    }
    return "";
  });
  return { names, stripped };
}

export function compileModelSource(source: string): string {
  const { names: strippedNames, stripped } = extractStrippedNames(source);

  const result = ts.transpileModule(stripped, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const first = errors[0];
    const text = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    throw new Error(`model source compile failed: ${text}`);
  }

  // 为剥离的标识符提供 stub，使模块加载不报错。
  // 工厂函数不调用这些；它们仅被 environment/postprocessing 辅助函数引用。
  const stubs = strippedNames.length > 0
    ? strippedNames.map((n) => `var ${n}=function(){};`).join("\n") + "\n"
    : "";

  return stubs + result.outputText;
}
