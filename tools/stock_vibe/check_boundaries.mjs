import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "../..");
const require = createRequire(import.meta.url);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function loadTypeScript(root) {
  const explicit = process.env.STOCK_VIBE_TYPESCRIPT;
  const locations = [path.join(root, "webui"), root, path.join(defaultRoot, "webui"), scriptDir];
  if (explicit) {
    try {
      return require(path.resolve(explicit));
    } catch {
      locations.unshift(path.dirname(path.resolve(explicit)));
    }
  }
  for (const location of locations) {
    try {
      return require(require.resolve("typescript", { paths: [location] }));
    } catch {
      // Try the next normal project dependency location.
    }
  }
  throw new Error("TypeScript is unavailable; install the locked webui dependencies or set STOCK_VIBE_TYPESCRIPT.");
}

function readCompilerOptions(ts, webRoot) {
  const configPath = path.join(webRoot, "tsconfig.json");
  if (!fs.existsSync(configPath)) {
    return {
      baseUrl: webRoot,
      paths: { "@/*": ["src/*"] },
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, webRoot, undefined, configPath);
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
  }
  return parsed.options;
}

function listSources(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSources(full));
    else if (/\.(?:ts|tsx|mts|cts|js|jsx)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) files.push(full);
  }
  return files;
}

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isOldStockModule(file, sourceRoot) {
  const normalized = path.resolve(file);
  const oldComponents = path.join(sourceRoot, "components", "stock");
  const relative = path.relative(oldComponents, normalized);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return true;
  const lib = path.join(sourceRoot, "lib");
  return path.dirname(normalized) === lib && /^stock-api\.(?:[cm]?[jt]sx?)$/i.test(path.basename(normalized));
}

function isPureUiBoundary(file, sourceRoot) {
  return isWithin(file, path.join(sourceRoot, "components", "ui"));
}

function moduleSpecifiers(ts, sourceFile) {
  const found = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, node });
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamic || requireCall) found.push({ specifier: node.arguments[0].text, node });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function findStringRoutes(ts, sourceFile) {
  const found = [];
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes("/api/stock/")) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function checkTypeScript(root, ts) {
  const webRoot = path.join(root, "webui");
  const sourceRoot = path.join(webRoot, "src");
  const options = readCompilerOptions(ts, webRoot);
  const entries = listSources(path.join(sourceRoot, "components", "stock-vibe"));
  const requestModule = path.join(sourceRoot, "lib", "stock-vibe-api.ts");
  if (fs.existsSync(requestModule)) entries.push(requestModule);

  const pending = [...new Set(entries.map((item) => path.resolve(item)))];
  const visited = new Set();
  const errors = [];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    } catch (error) {
      errors.push(`${path.relative(root, file)}: cannot read TypeScript source: ${error.message}`);
      continue;
    }

    for (const node of findStringRoutes(ts, sourceFile)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      errors.push(`${path.relative(root, file)}:${position.line + 1}: old /api/stock/ URL`);
    }

    for (const { specifier, node } of moduleSpecifiers(ts, sourceFile)) {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const target = path.resolve(resolved);
      if (isOldStockModule(target, sourceRoot)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        errors.push(`${path.relative(root, file)}:${position.line + 1}: old stock dependency ${path.relative(sourceRoot, target).replaceAll("\\", "/")}`);
      } else if (!isPureUiBoundary(target, sourceRoot) && !visited.has(target)) {
        pending.push(target);
      }
    }
  }
  return { entries, visited, errors };
}

const root = path.resolve(argument("--root", defaultRoot));
try {
  const ts = loadTypeScript(root);
  const result = checkTypeScript(root, ts);
  if (result.errors.length) {
    console.error("TypeScript stock Vibe boundary violations:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`TypeScript stock Vibe boundary check passed (${result.entries.length} roots, ${result.visited.size} modules).`);
  }
} catch (error) {
  console.error(`TypeScript stock Vibe boundary check failed: ${error.message}`);
  process.exitCode = 2;
}
