import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  cancelSchedule: vi.fn(),
  createSchedule: vi.fn(),
  getRequest: vi.fn(),
  updateSchedule: vi.fn(),
  nextId: 0,
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  cancelStockVibeSchedule: api.cancelSchedule,
  createStockVibeRequestId: () => `${"0".repeat(31)}${(++api.nextId).toString(16)}`,
  createStockVibeSchedule: api.createSchedule,
  getStockVibeRequest: api.getRequest,
  updateStockVibeSchedule: api.updateSchedule,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));

import { StockVibeFollowup } from "./StockVibeFollowup";

const STORAGE_KEY = "mona.stock-vibe.followup.v1:002460.SZ";
const PREFERENCES_KEY = "mona.stock-vibe.followup-times.v1:002460.SZ";
const TASK_LABELS = ["综合分析", "财报与估值", "走势分析", "风险检查"] as const;

function requestRecord(
  requestId: string,
  method: string,
  path: string,
  status: "completed" | "pending" | "rejected",
  body: unknown = null,
  statusCode = 201,
) {
  return {
    request_id: requestId,
    method,
    path,
    payload_sha256: "a".repeat(64),
    status,
    error_category: null,
    source: null,
    source_sha256: null,
    receipt: status === "completed" || status === "rejected" ? { status_code: statusCode, body } : null,
    receipt_sha256: status === "completed" || status === "rejected" ? "b".repeat(64) : null,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
}

const job = {
  id: "followup_1",
  title: "002460 综合分析跟进",
  status: "pending",
  schedule: "0 16 * * 1-5",
  timezone: "Asia/Shanghai",
  config: { mona_workbench: { symbol: "002460.SZ", task: "comprehensive" as const, mode: "swing" as const } },
  next_run_at: "2026-10-19T08:00:00Z",
  last_run_at: null,
};

const laterJob = {
  ...job,
  id: "followup_2",
  title: "002460 财报与估值跟进",
  config: { mona_workbench: { symbol: "002460.SZ", task: "fundamental" as const, mode: "swing" as const } },
  next_run_at: "2026-10-20T08:00:00Z",
};

function renderFollowup(overrides: Partial<ComponentProps<typeof StockVibeFollowup>> = {}) {
  const props: ComponentProps<typeof StockVibeFollowup> = {
    symbol: "002460.SZ",
    mode: "swing",
    jobs: [],
    scheduler: { executable: true },
    onChanged: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  return { ...render(<StockVibeFollowup {...props} />), props };
}

beforeEach(() => {
  localStorage.clear();
  api.nextId = 0;
  api.cancelSchedule.mockReset();
  api.createSchedule.mockReset();
  api.getRequest.mockReset();
  api.updateSchedule.mockReset();
  api.getRequest.mockResolvedValue(requestRecord("0".repeat(32), "POST", "/scheduled-runs", "pending"));
});

describe("StockVibeFollowup", () => {
  it("remembers a weekly Sunday schedule and sends Sunday as zero when enabled", async () => {
    api.createSchedule.mockImplementation(async (requestId: string, input: { id: string }) =>
      requestRecord(requestId, "POST", "/scheduled-runs", "completed", { id: input.id }));
    const first = renderFollowup();
    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    fireEvent.click(screen.getByRole("radio", { name: "每周", exact: true }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "每周执行日" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "周日" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(api.createSchedule).not.toHaveBeenCalled();
    first.unmount();
    renderFollowup();
    expect(screen.getByText("每周日 16:00 · 未开启")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    expect(screen.getByRole("radio", { name: "每周", exact: true })).toBeChecked();
    expect(screen.getByRole("button", { name: "每周执行日" })).toHaveTextContent("周日");
    fireEvent.click(screen.getByRole("button", { name: "关闭", exact: true }));
    fireEvent.click(screen.getByRole("switch", { name: "开启综合分析跟进" }));
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalledOnce());
    expect(api.createSchedule.mock.calls[0][1]).toMatchObject({ schedule: "0 16 * * 0", timezone: "Asia/Shanghai" });
  });

  it("restores selected weekdays from a native plan and updates the same plan with the new days", async () => {
    api.updateSchedule.mockImplementation(async (id: string, requestId: string) =>
      requestRecord(requestId, "PATCH", `/scheduled-runs/${id}`, "completed", { id }, 200));
    renderFollowup({ jobs: [{ ...job, schedule: "0 16 * * 1,3,5" }] });
    expect(screen.getByText("每周一、三、五 16:00 · 波段")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    expect(screen.getByRole("radio", { name: "自定义星期" })).toBeChecked();
    for (const day of ["周一", "周三", "周五"]) expect(screen.getByRole("checkbox", { name: day })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "周二" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "周三" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "周日" }));
    fireEvent.change(screen.getByLabelText("执行时间（北京时间）"), { target: { value: "18:15" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledOnce());
    expect(api.updateSchedule.mock.calls[0]).toEqual([job.id, expect.any(String), { schedule: "15 18 * * 1,5,0", timezone: "Asia/Shanghai" }]);
    expect(api.createSchedule).not.toHaveBeenCalled();
  });

  it("asks for a weekday beside the field when custom selection is empty", () => {
    renderFollowup();
    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    fireEvent.click(screen.getByRole("radio", { name: "自定义星期" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "周一" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请至少选择一天。");
    expect(api.createSchedule).not.toHaveBeenCalled();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "周五" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows four task controls while reads are unavailable and disables writes until retry", () => {
    const { props, rerender } = renderFollowup({ readState: "loading" });
    expect(screen.getByText("正在读取…")).toBeInTheDocument();
    expect(screen.queryByText("未设置")).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    for (const label of TASK_LABELS) {
      expect(screen.getByRole("switch", { name: "开启" + label + "跟进" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "设置" + label + "跟进" })).toBeDisabled();
    }
    rerender(<StockVibeFollowup {...props} readState="unavailable" />);
    expect(screen.getByText("计划暂未取得")).toBeInTheDocument();
    for (const label of TASK_LABELS) {
      expect(screen.getByRole("switch", { name: "开启" + label + "跟进" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "设置" + label + "跟进" })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onChanged).toHaveBeenCalledOnce();
    expect(api.createSchedule).not.toHaveBeenCalled();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(api.cancelSchedule).not.toHaveBeenCalled();
  });

  it("shows independent task switches and groups plans by their symbol and task context", () => {
    const wrongSymbol = { ...job, id: "wrong_symbol", config: { mona_workbench: { symbol: "600000.SH", task: "comprehensive" as const, mode: "swing" as const } } };
    const technical = { ...job, id: "technical", title: "002460 综合分析跟进", config: { mona_workbench: { symbol: "002460.SZ", task: "technical" as const, mode: "swing" as const } } };
    renderFollowup({ jobs: [wrongSymbol, technical] });

    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "开启综合分析跟进" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "开启财报与估值跟进" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "开启走势分析跟进" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "开启风险检查跟进" })).toHaveAttribute("aria-checked", "false");
    for (const label of TASK_LABELS) {
      const settings = screen.getByRole("button", { name: "设置" + label + "跟进" });
      expect(settings).toBeEnabled();
      expect(settings).toHaveAttribute("title", "设置" + label + "跟进");
      expect(settings.textContent).toBe("");
      expect(settings.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("stores an off task's time without creating a plan until its switch is enabled", async () => {
    api.createSchedule.mockImplementation(async (requestId: string, input: { id: string }) => (
      requestRecord(requestId, "POST", "/scheduled-runs", "completed", { id: input.id })
    ));
    const onChanged = vi.fn();
    const onError = vi.fn();
    renderFollowup({ onChanged, onError });

    const switchControl = screen.getByRole("switch", { name: "开启综合分析跟进" });
    expect(switchControl).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    expect(screen.queryByRole("heading", { name: "已有计划" })).not.toBeInTheDocument();
    expect(screen.getByText(/执行日期按日历安排，不会自动跳过 A 股休市日。/)).toBeInTheDocument();
    expect(screen.getByLabelText("执行时间（北京时间）")).toHaveValue("16:00");
    expect(screen.getByRole("radio", { name: "周一至周五" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("执行时间（北京时间）"), { target: { value: "17:30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createSchedule).not.toHaveBeenCalled();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}")).toMatchObject({
      comprehensive: { time: "17:30", frequency: "weekdays" },
    });
    expect(switchControl).toHaveAttribute("aria-checked", "false");

    fireEvent.click(switchControl);
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalledOnce());
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [requestId, input] = api.createSchedule.mock.calls[0];
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(input).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{32}$/),
      title: "002460 综合分析跟进",
      prompt: expect.stringContaining("研究周期：波段"),
      schedule: "30 17 * * 1-5",
      timezone: "Asia/Shanghai",
      workbench: { symbol: "002460.SZ", task: "comprehensive", mode: "swing" },
    });
    expect(input.prompt).toContain("综合研究这只股票");
    expect(api.getRequest).not.toHaveBeenCalled();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}")).toMatchObject({
      comprehensive: { time: "17:30", frequency: "weekdays" },
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("turns off only the selected task job and refreshes the workbench", async () => {
    api.cancelSchedule.mockImplementation(async (jobId: string, requestId: string) => (
      requestRecord(requestId, "DELETE", `/scheduled-runs/${jobId}`, "completed", { status: "cancelled" }, 200)
    ));
    const onChanged = vi.fn();
    const onError = vi.fn();
    renderFollowup({ jobs: [job, laterJob], onChanged, onError });

    expect(screen.queryByText(job.title)).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "开启综合分析跟进" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "开启财报与估值跟进" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "开启综合分析跟进" }));

    await waitFor(() => expect(api.cancelSchedule).toHaveBeenCalledOnce());
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [jobId, requestId] = api.cancelSchedule.mock.calls[0];
    expect(jobId).toBe(job.id);
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(api.createSchedule).not.toHaveBeenCalled();
    expect(api.updateSchedule).not.toHaveBeenCalled();
    expect(api.getRequest).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "开启综合分析跟进" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "开启财报与估值跟进" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("定时跟进已取消；已开始的研究会继续。")).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("updates an enabled task with PATCH while retaining the job id and context", async () => {
    api.updateSchedule.mockImplementation(async (jobId: string, requestId: string, input: { schedule: string; timezone: "Asia/Shanghai" }) => (
      requestRecord(requestId, "PATCH", `/scheduled-runs/${jobId}`, "completed", { id: jobId }, 200)
    ));
    const onChanged = vi.fn();
    const onError = vi.fn();
    renderFollowup({ jobs: [job], onChanged, onError });

    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    expect(screen.getByLabelText("执行时间（北京时间）")).toHaveValue("16:00");
    fireEvent.change(screen.getByLabelText("执行时间（北京时间）"), { target: { value: "18:15" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledOnce());
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const [jobId, requestId, input] = api.updateSchedule.mock.calls[0];
    expect(jobId).toBe(job.id);
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(input).toEqual({ schedule: "15 18 * * 1-5", timezone: "Asia/Shanghai" });
    expect(screen.getByRole("switch", { name: "开启综合分析跟进" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("跟进时间已更新。")).toBeInTheDocument();
    expect(api.createSchedule).not.toHaveBeenCalled();
    expect(api.cancelSchedule).not.toHaveBeenCalled();
    expect(api.getRequest).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("shows configured tasks when the scheduler cannot execute them yet", () => {
    renderFollowup({ jobs: [job, laterJob], scheduler: { executable: false } });

    expect(screen.getByText("计划已保存，暂不能自动执行。")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "开启综合分析跟进" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "开启财报与估值跟进" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "设置综合分析跟进" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "设置财报与估值跟进" })).toBeEnabled();
  });

  it("opens directly to the form when no plan exists and scheduler is unavailable", () => {
    renderFollowup({ scheduler: { executable: false } });

    expect(screen.getAllByText("周一至周五 16:00 · 未开启")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));

    expect(screen.getByLabelText("执行时间（北京时间）")).toBeInTheDocument();
    expect(screen.getByLabelText("执行时间（北京时间）")).toHaveValue("16:00");
    expect(screen.getByRole("radio", { name: "周一至周五" })).toBeChecked();
    expect(api.createSchedule).not.toHaveBeenCalled();
  });

  it("checks the original request after a timeout and never submits it again", async () => {
    api.createSchedule.mockRejectedValue(new Error("socket timed out"));
    api.getRequest.mockImplementation(async (requestId: string) => (
      requestRecord(requestId, "POST", "/scheduled-runs", "pending")
    ));
    const onError = vi.fn();
    const first = renderFollowup({ onError });

    fireEvent.click(screen.getByRole("switch", { name: "开启综合分析跟进" }));

    await screen.findByRole("button", { name: "核对结果" });
    expect(api.createSchedule).toHaveBeenCalledOnce();
    expect(api.getRequest).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("结果尚未确认，请核对原请求；系统不会自动重发。");
    expect(screen.getByRole("button", { name: "设置综合分析跟进" })).toBeDisabled();
    expect(onError).toHaveBeenCalledOnce();

    first.unmount();
    renderFollowup({ onError });
    await waitFor(() => expect(api.getRequest).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "核对结果" }));
    await waitFor(() => expect(api.getRequest).toHaveBeenCalledTimes(3));
    expect(api.createSchedule).toHaveBeenCalledOnce();
  });

  it("checks an unknown PATCH after remount without submitting the update again", async () => {
    api.updateSchedule.mockRejectedValue(new Error("socket timed out"));
    api.getRequest.mockImplementation(async (requestId: string) => (
      requestRecord(requestId, "PATCH", `/scheduled-runs/${job.id}`, "pending")
    ));
    const first = renderFollowup({ jobs: [job] });

    fireEvent.click(screen.getByRole("button", { name: "设置综合分析跟进" }));
    fireEvent.change(screen.getByLabelText("执行时间（北京时间）"), { target: { value: "17:30" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByRole("button", { name: "核对结果" });
    expect(api.updateSchedule).toHaveBeenCalledOnce();
    expect(api.getRequest).toHaveBeenCalledOnce();

    first.unmount();
    renderFollowup({ jobs: [job] });
    await waitFor(() => expect(api.getRequest).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "核对结果" }));
    await waitFor(() => expect(api.getRequest).toHaveBeenCalledTimes(3));
    expect(api.updateSchedule).toHaveBeenCalledOnce();
    expect(api.createSchedule).not.toHaveBeenCalled();
    expect(api.cancelSchedule).not.toHaveBeenCalled();
  });

  it("stops cancelling a task's remaining plans when the first result is unknown", async () => {
    api.cancelSchedule.mockRejectedValue(new Error("socket timed out"));
    api.getRequest.mockImplementation(async (requestId: string) => (
      requestRecord(requestId, "DELETE", `/scheduled-runs/${job.id}`, "pending")
    ));
    const secondComprehensiveJob = { ...job, id: "followup_3", title: "另一个综合分析跟进" };
    renderFollowup({ jobs: [job, secondComprehensiveJob] });

    fireEvent.click(screen.getByRole("switch", { name: "开启综合分析跟进" }));
    await screen.findByRole("button", { name: "核对结果" });

    expect(api.cancelSchedule).toHaveBeenCalledOnce();
    expect(api.cancelSchedule.mock.calls[0][0]).toBe(job.id);
    expect(api.getRequest).toHaveBeenCalledOnce();
  });

  it("submits only one create when the enable switch is clicked while pending", () => {
    api.createSchedule.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = renderFollowup();
    const switchControl = screen.getByRole("switch", { name: "开启综合分析跟进" });

    fireEvent.click(switchControl);
    fireEvent.click(switchControl);

    expect(api.createSchedule).toHaveBeenCalledOnce();
    expect(switchControl).toBeDisabled();
    unmount();
    localStorage.clear();
  });
});
