import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  StockDashboardItem,
  StockIntradaySeries,
  StockIntradayStreamHandlers,
} from "@/lib/stock-api";

const fetchStockIntraday = vi.fn();
const openStockIntradayStream = vi.fn();
let streamHandlers: StockIntradayStreamHandlers | null = null;

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockIntraday: (...args: unknown[]) => fetchStockIntraday(...args),
    openStockIntradayStream: (...args: unknown[]) => openStockIntradayStream(...args),
  };
});

import { InstrumentStage } from "./InstrumentStage";

const ITEM: StockDashboardItem = {
  instrumentId: "XSHE:002709",
  name: "天赐材料",
  instrumentType: "equity",
  focus: true,
  latest: null,
};

const SNAPSHOT: StockIntradaySeries = {
  instrumentId: ITEM.instrumentId,
  instrumentType: "equity",
  tradingDate: "2026-08-18",
  previousClose: 40,
  status: "trading",
  asOf: "2026-08-18T10:00:00+08:00",
  source: {
    provider: "eastmoney",
    fetchedAt: "2026-08-18T10:00:00+08:00",
    id: "qa",
    url: "https://example.test/intraday",
    publishedAt: null,
    contentHash: "qa",
    fields: [],
  },
  points: [
    {
      time: "2026-08-18T09:30:00+08:00",
      open: 40,
      high: 40.2,
      low: 40,
      close: 40.1,
      price: 40.1,
      average: 40.1,
      volume: 100,
      amount: 401000,
    },
  ],
  stale: false,
  quality: "complete",
  error: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  streamHandlers = null;
  fetchStockIntraday.mockResolvedValue(SNAPSHOT);
  openStockIntradayStream.mockImplementation(
    (_instrumentId: string, handlers: StockIntradayStreamHandlers) => {
      streamHandlers = handlers;
      return Promise.resolve({ close: vi.fn() });
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function renderStage() {
  return render(
    <InstrumentStage
      token=""
      item={ITEM}
      quote={undefined}
      kline={null}
      klineState="idle"
      period="daily"
      onPeriodChange={() => undefined}
      onRetryKline={() => undefined}
      run={null}
      stepActivities={{}}
      starting={false}
      cancellingRun={false}
      onStartRun={() => undefined}
      onCancelRun={() => undefined}
      reports={[]}
      reportDetail={null}
      researchContext={null}
      onOpenReport={() => undefined}
      onDeleteReport={() => undefined}
    />,
  );
}

async function settleInitialStream() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(streamHandlers).not.toBeNull();
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("InstrumentStage intraday SSE reconnect grace", () => {
  it("does not show a warning for a transient stream error", async () => {
    renderStage();
    await settleInitialStream();

    act(() => streamHandlers?.onError?.(new Event("error")));
    expect(screen.queryByText("分时连接已断开，正在重连")).not.toBeInTheDocument();

    act(() => streamHandlers?.onSnapshot?.(SNAPSHOT));
    await advanceTimers(3_001);
    expect(screen.queryByText("分时连接已断开，正在重连")).not.toBeInTheDocument();
  });

  it("keeps the grace timer across failed reconnect rounds and warns after 3 seconds", async () => {
    renderStage();
    await settleInitialStream();

    act(() => streamHandlers?.onError?.(new Event("error")));
    await advanceTimers(1_000);
    await settleInitialStream();
    act(() => streamHandlers?.onError?.(new Event("error")));

    await advanceTimers(1_999);
    expect(screen.queryByText("分时连接已断开，正在重连")).not.toBeInTheDocument();
    await advanceTimers(1);
    expect(screen.getByText("分时连接已断开，正在重连")).toBeInTheDocument();
  });

  it("clears the warning only after an SSE snapshot restores the stream", async () => {
    renderStage();
    await settleInitialStream();

    act(() => streamHandlers?.onError?.(new Event("error")));
    await advanceTimers(3_000);
    expect(screen.getByText("分时连接已断开，正在重连")).toBeInTheDocument();

    act(() => streamHandlers?.onSnapshot?.(SNAPSHOT));
    expect(screen.queryByText("分时连接已断开，正在重连")).not.toBeInTheDocument();
    expect(screen.queryByText("连接中断，保留最近快照")).not.toBeInTheDocument();
  });
});
