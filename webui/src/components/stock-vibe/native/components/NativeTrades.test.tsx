import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { NativeTrades } from "./NativeTrades";
import type { RunData } from "../lib/api";
import i18n from "../i18n";
import wire from "../fixtures/ml-trades-first-two-wire.json";

it("replays native ML execution-event CSV rows with original sorting, filtering and percentage units", () => {
  const run: RunData = { status: "success", run_id: wire.run_id, artifacts_trades_csv: wire.rows, trade_log: wire.rows.slice(0, 1) };
  render(<NativeTrades run={run} />);
  const table = screen.getByRole("table"), rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(within(rows[1]).getByText("2023-01-09")).toBeInTheDocument();
  expect(within(rows[1]).getByText("卖出")).toBeInTheDocument();
  expect(within(rows[1]).getByText("37.5968")).toBeInTheDocument();
  expect(within(rows[1]).getByText("1300")).toBeInTheDocument();
  expect(within(rows[1]).getByText("+3185.58")).toHaveClass("text-[hsl(var(--stock-up))]");
  expect(within(rows[1]).getByText("+6.97%")).toBeInTheDocument();
  expect(within(rows[1]).getByText("14")).toBeInTheDocument();
  expect(within(rows[1]).getByText("策略信号")).toBeInTheDocument();
  expect(screen.queryByText("+697.00%")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("runDetail.sideBuy") }));
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  expect(within(table).getByText("35.1463")).toBeInTheDocument();
  expect(within(table).queryByText("37.5968")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("runDetail.sideAll") }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("runDetail.time") }));
  expect(within(within(table).getAllByRole("row")[1]).getByText("2022-12-26")).toBeInTheDocument();
});
