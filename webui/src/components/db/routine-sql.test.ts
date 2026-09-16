import { describe, expect, it } from "vitest";
import { singleQueryStatement } from "./query-sql";
import { duplicateRoutineSql, routineListSql, routineTemplate } from "./routine-sql";

describe("stored routine SQL", () => {
  it("turns the editor delimiter wrapper into one executable MySQL statement", () => {
    const sql = singleQueryStatement(routineTemplate("procedure"), false);
    expect(sql).toContain("CREATE PROCEDURE `procedure_name`()");
    expect(sql).toContain("SELECT 1;");
    expect(sql).not.toContain("DELIMITER");
  });

  it("creates editable function and duplicate drafts", () => {
    expect(routineTemplate("function")).toContain("CREATE FUNCTION `function_name`()");
    expect(duplicateRoutineSql("CREATE DEFINER=`root`@`%` PROCEDURE `sync_data`() BEGIN SELECT 1; END", "sync_data"))
      .toContain("PROCEDURE `sync_data_copy`()");
  });

  it("quotes the selected schema in the routine list query", () => {
    expect(routineListSql("team's data")).toContain("ROUTINE_SCHEMA = 'team''s data'");
  });
});
