import type { DatabaseObjectType } from "./types";

export type RoutineType = Extract<DatabaseObjectType, "procedure" | "function">;

export function routineTemplate(type: RoutineType): string {
  if (type === "function") {
    return "DELIMITER $$\nCREATE FUNCTION `function_name`()\nRETURNS VARCHAR(255)\nDETERMINISTIC\nBEGIN\n  DECLARE result VARCHAR(255);\n  -- 在此编写函数逻辑\n  RETURN result;\nEND$$\nDELIMITER ;";
  }
  return "DELIMITER $$\nCREATE PROCEDURE `procedure_name`()\nBEGIN\n  -- 在此编写存储过程逻辑\n  SELECT 1;\nEND$$\nDELIMITER ;";
}

export function routineListSql(database: string): string {
  return `SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, CREATED, LAST_ALTERED\nFROM information_schema.ROUTINES\nWHERE ROUTINE_SCHEMA = '${database.replace(/'/g, "''")}'\nORDER BY ROUTINE_TYPE, ROUTINE_NAME`;
}

export function duplicateRoutineSql(definition: string, name: string): string {
  const copyName = `${name}_copy`;
  return definition.replace(
    /(\b(?:PROCEDURE|FUNCTION)\s+)(?:`(?:``|[^`])+`|[A-Za-z0-9_$]+)(?=\s*\()/i,
    `$1\`${copyName.replace(/`/g, "``")}\``,
  );
}
