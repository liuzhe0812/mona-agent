import { MySQL, SQLite } from "@codemirror/lang-sql";

export function singleQueryStatement(source: string, sqlite: boolean): string {
  const routine = sqlite ? null : mysqlRoutineStatement(source);
  if (routine) return routine;
  const tree = (sqlite ? SQLite : MySQL).language.parser.parse(source);
  const statements: string[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Statement") {
      const statement = source.slice(node.from, node.to).trim();
      if (statement !== ";") statements.push(statement);
    }
  }
  if (statements.length !== 1) throw new Error("当前支持单条 SQL。请选中需要执行的语句后再运行。");
  const sql = statements[0];
  if (/^(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b|SAVEPOINT\b|RELEASE\s+SAVEPOINT\b)/i.test(sql)) {
    throw new Error("此查询页不支持跨次执行的手动事务。");
  }
  if (/^USE\b/i.test(sql)) throw new Error("请通过工具栏选择数据库，使执行目标与当前标签保持一致。");
  return sql;
}

function mysqlRoutineStatement(source: string): string | null {
  let sql = source.trim();
  const delimiter = sql.match(/^DELIMITER\s+(\S+)\s*(?:\r?\n|$)/i);
  if (delimiter) {
    sql = sql.slice(delimiter[0].length).trim();
    const suffix = new RegExp(`${escapeRegExp(delimiter[1])}\\s*(?:\\r?\\n\\s*DELIMITER\\s+;)?\\s*$`, "i");
    sql = sql.replace(suffix, "").trim();
  }
  const withoutComments = sql.replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$)|\s*\/\*[\s\S]*?\*\/\s*)*/, "");
  return /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION)\b/i.test(withoutComments)
    ? sql.replace(/;\s*$/, "").trim()
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
