import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  DocumentVersion,
  OfficeApplyCommand,
  OfficeCheckpointMetadata,
  OfficeCommandResult,
  OfficeInspectRequest,
  OfficeInspectResult,
  OfficeSessionState,
  OfficeSocketMessage,
} from "./types";

interface ContractFixture {
  documentVersion: DocumentVersion;
  session: OfficeSessionState;
  inspectRequests: OfficeInspectRequest[];
  inspectResults: OfficeInspectResult[];
  command: OfficeApplyCommand;
  commandResults: OfficeCommandResult[];
  checkpoint: OfficeCheckpointMetadata;
  socketMessages: OfficeSocketMessage[];
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../tests/fixtures/office/d0-contract.json"), "utf8"),
) as ContractFixture;

describe("Mona Office D0 contract", () => {
  it("consumes the shared Python and TypeScript fixture", () => {
    expect(fixture.documentVersion).toEqual({ editorEpoch: "epoch_d0", modelRevision: 4 });
    expect(fixture.session.type).toBe("sheets");
    expect(fixture.inspectRequests.map(({ query }) => query.mode)).toEqual(["summary", "range"]);
    expect(fixture.inspectResults.map(({ result }) => result.mode)).toEqual(["summary", "range"]);
    expect(fixture.command.operations.map(({ op }) => op)).toEqual([
      "set_cell",
      "set_range",
      "set_formula",
      "clear_range",
      "set_style",
    ]);
    expect(fixture.commandResults.map(({ ok }) => ok)).toEqual([true, false]);
    expect(fixture.checkpoint.sha256).toHaveLength(64);
    expect(fixture.socketMessages.map(({ event }) => event)).toEqual([
      "office_editor_ready",
      "office_inspect_command",
      "office_inspect_result",
      "office_command_result",
    ]);
  });
});
