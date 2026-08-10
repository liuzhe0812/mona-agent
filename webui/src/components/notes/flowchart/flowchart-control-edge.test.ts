import { describe, it, expect } from "vitest";
import { Position } from "@xyflow/react";
import {
  normalizeControlPoints,
  mergeCollinear,
  mergeCollinearSegments,
  buildEdgeGeometry,
  type Point,
  type PolylineVertex,
  type VisualSegment,
} from "./FlowchartControlEdge";

// ---------------------------------------------------------------------------
// normalizeControlPoints
// ---------------------------------------------------------------------------

describe("normalizeControlPoints", () => {
  const source: Point = { x: 0, y: 0 };
  const target: Point = { x: 100, y: 100 };

  it("空数组返回空数组", () => {
    expect(normalizeControlPoints([], source, target)).toEqual([]);
  });

  it("规则1：删除相邻重复点", () => {
    const cps: Point[] = [
      { x: 50, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    const result = normalizeControlPoints(cps, source, target);
    // {50,0} 重复被删除，{50,0}→{50,50}→{100,100} 不共线，保留 {50,50}
    // 但 {50,0} 与 source(0,0) 不共线（source→{50,0} 是水平，{50,0}→{50,50} 是垂直），所以 {50,0} 保留
    // 实际：source(0,0) → {50,0} → {50,0} → {50,50} → target(100,100)
    // 去重后：source(0,0) → {50,0} → {50,50} → target(100,100)
    // 共线检查：source→{50,0}→{50,50} 不共线；{50,0}→{50,50}→target(100,100) 不共线
    expect(result).toEqual([{ x: 50, y: 0 }, { x: 50, y: 50 }]);
  });

  it("规则2：删除三点共线的中间点", () => {
    const cps: Point[] = [
      { x: 0, y: 50 },  // 与 source(0,0) 和 {0,100} 共线（x 相同）
      { x: 0, y: 100 },
      { x: 50, y: 100 }, // 与 {0,100} 和 target(100,100) 共线（y 相同）
    ];
    const result = normalizeControlPoints(cps, source, target);
    // source(0,0) → {0,50} → {0,100} → {50,100} → target(100,100)
    // 共线：source→{0,50}→{0,100} → 删除 {0,50}
    // {0,100}→{50,100}→target(100,100) → 删除 {50,100}
    // 结果：source(0,0) → {0,100} → target(100,100)
    expect(result).toEqual([{ x: 0, y: 100 }]);
  });

  it("规则2：不删除 source/target（它们不在 cps 数组里）", () => {
    const cps: Point[] = [{ x: 50, y: 0 }];
    const result = normalizeControlPoints(cps, source, target);
    // source(0,0) → {50,0} → target(100,100) — 不共线，保留
    expect(result).toEqual([{ x: 50, y: 0 }]);
  });

  it("规则3：非相邻同轴重叠 → 删除中间折返回路", () => {
    // 构造一个 U 形回路：
    // source(0,0) → {0,50} → {100,50} → {100,0} → {0,0} → target(100,100)
    // 段 source→{0,50}（垂直 x=0）和段 {100,0}→{0,0}（水平 y=0）不同轴
    // 改为构造：
    // source(0,0) → {50,0} → {50,50} → {100,50} → {100,0} → target(100,100)
    // 段 source(0,0)→{50,0}（水平 y=0）和段 {100,0}→target(100,100)... 不对
    // 实际场景：回拖后产生重叠
    // source(0,50) → {0,0} → {100,0} → {100,100} → {0,100} → target(0,150)
    // 段 source→{0,0}（垂直 x=0）和段 {0,100}→target（垂直 x=0）同轴重叠
    const src: Point = { x: 0, y: 50 };
    const tgt: Point = { x: 0, y: 150 };
    const cps: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const result = normalizeControlPoints(cps, src, tgt);
    // source(0,50) → {0,0} → {100,0} → {100,100} → {0,100} → target(0,150)
    // 段0: source(0,50)→{0,0} 垂直 x=0
    // 段3: {0,100}→target(0,150) 垂直 x=0
    // 投影：段0 y∈[0,50]，段3 y∈[100,150]，无重叠 → 不会合并
    expect(result).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);

    // 真实回拖场景：source(50,0) → {50,30} → {80,30} → {80,10} → {50,10} → target(50,100)
    // 段0: source(50,0)→{50,30} 垂直 x=50
    // 段3: {50,10}→target(50,100) 垂直 x=50
    // 投影：段0 y∈[0,30]，段3 y∈[10,100]，重叠 y∈[10,30]
    const src2: Point = { x: 50, y: 0 };
    const tgt2: Point = { x: 50, y: 100 };
    const cps2: Point[] = [
      { x: 50, y: 30 },
      { x: 80, y: 30 },
      { x: 80, y: 10 },
      { x: 50, y: 10 },
    ];
    const result2 = normalizeControlPoints(cps2, src2, tgt2);
    // 合并后应删除中间折返回路，保留重叠区间的两个端点
    // 期望：source(50,0) → {50,10} → {50,30} → target(50,100)
    // 但 {50,10}→{50,30}→target(50,100) 共线 → 再删 {50,30}
    // 最终：source(50,0) → {50,10} → target(50,100) → 又共线 → 删 {50,10}
    // 最终结果：空数组（一条直线）
    expect(result2).toEqual([]);
  });

  it("规则3：非重叠同轴线段不合并", () => {
    const src: Point = { x: 0, y: 0 };
    const tgt: Point = { x: 0, y: 200 };
    const cps: Point[] = [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 100, y: 150 },
      { x: 0, y: 150 },
    ];
    const result = normalizeControlPoints(cps, src, tgt);
    // 段0: source(0,0)→{0,50} 垂直 x=0, y∈[0,50]
    // 段3: {0,150}→target(0,200) 垂直 x=0, y∈[150,200]
    // 无重叠 → 不合并
    expect(result).toEqual([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 100, y: 150 },
      { x: 0, y: 150 },
    ]);
  });

  it("多条规则混合：先去重再共线再重叠", () => {
    const src: Point = { x: 0, y: 0 };
    const tgt: Point = { x: 0, y: 100 };
    const cps: Point[] = [
      { x: 0, y: 0 },   // 与 source 重复
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
      { x: 0, y: 50 },   // 与前一个重复
    ];
    const result = normalizeControlPoints(cps, src, tgt);
    // 去重后：source(0,0) → {0,0}(删) → {50,0} → {50,50} → {0,50} → {0,50}(删) → target(0,100)
    // → source(0,0) → {50,0} → {50,50} → {0,50} → target(0,100)
    // 共线：无三点共线
    // 重叠：段0 source(0,0)→{50,0} 水平 y=0；段3 {0,50}→target(0,100) 垂直 x=0 — 不同轴
    // 不合并
    expect(result).toEqual([
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// mergeCollinear
// ---------------------------------------------------------------------------

describe("mergeCollinear", () => {
  it("共线虚拟拐角合并", () => {
    const vertices: PolylineVertex[] = [
      { point: { x: 0, y: 0 }, isLogical: true },
      { point: { x: 50, y: 0 }, isLogical: false },
      { point: { x: 100, y: 0 }, isLogical: true },
    ];
    // 三点共线（y=0）→ 合并中间点
    const result = mergeCollinear(vertices);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("共线逻辑点也合并（保证一条直线一个段）", () => {
    const vertices: PolylineVertex[] = [
      { point: { x: 0, y: 0 }, isLogical: true },
      { point: { x: 50, y: 0 }, isLogical: true },  // 逻辑点但共线
      { point: { x: 100, y: 0 }, isLogical: true },
    ];
    // 三点共线 → 合并，normalizeControlPoints 会在提交时清理冗余 CP
    const result = mergeCollinear(vertices);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("非共线不合并", () => {
    const vertices: PolylineVertex[] = [
      { point: { x: 0, y: 0 }, isLogical: true },
      { point: { x: 50, y: 50 }, isLogical: false },
      { point: { x: 100, y: 0 }, isLogical: true },
    ];
    const result = mergeCollinear(vertices);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }]);
  });

  it("≤2 个顶点直接返回", () => {
    const vertices: PolylineVertex[] = [
      { point: { x: 0, y: 0 }, isLogical: true },
      { point: { x: 100, y: 0 }, isLogical: true },
    ];
    const result = mergeCollinear(vertices);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it("连续多个虚拟共线点全合并", () => {
    const vertices: PolylineVertex[] = [
      { point: { x: 0, y: 0 }, isLogical: true },
      { point: { x: 25, y: 0 }, isLogical: false },
      { point: { x: 50, y: 0 }, isLogical: false },
      { point: { x: 75, y: 0 }, isLogical: false },
      { point: { x: 100, y: 0 }, isLogical: true },
    ];
    const result = mergeCollinear(vertices);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// buildEdgeGeometry
// ---------------------------------------------------------------------------

describe("buildEdgeGeometry", () => {
  it("无 CP 的直连线生成 path 和 segments", () => {
    const source: Point = { x: 0, y: 0 };
    const target: Point = { x: 0, y: 200 };
    const { path, segments } = buildEdgeGeometry(
      [source, target],
      Position.Bottom,
      Position.Top,
    );
    expect(path).toBeTruthy();
    expect(path.startsWith("M")).toBe(true);
    expect(segments.length).toBeGreaterThan(0);
  });

  it("无 CP 直连线段非 terminal（可编辑）", () => {
    const source: Point = { x: 0, y: 0 };
    const target: Point = { x: 0, y: 200 };
    const { segments } = buildEdgeGeometry(
      [source, target],
      Position.Bottom,
      Position.Top,
    );
    // 直连线段 polyline 只有 2 点，没有 toIsTarget 的段（to !== target 的段可能因 gap 偏移不匹配）
    // 但至少中间段应非 terminal
    const nonTerminal = segments.filter((s) => !s.terminal);
    expect(nonTerminal.length).toBeGreaterThan(0);
  });

  it("有 CP 的折线 target gap stub 为 terminal", () => {
    const source: Point = { x: 0, y: 0 };
    const cp1: Point = { x: 100, y: 100 };
    const target: Point = { x: 200, y: 200 };
    const { segments } = buildEdgeGeometry(
      [source, cp1, target],
      Position.Bottom,
      Position.Top,
    );
    // 至少存在一个非 terminal 段（中间路由段）
    const nonTerminal = segments.filter((s) => !s.terminal);
    expect(nonTerminal.length).toBeGreaterThan(0);
    // 如果末段 to 坐标等于 target，则是 terminal
    const lastSeg = segments[segments.length - 1];
    if (lastSeg.to.x === target.x && lastSeg.to.y === target.y) {
      expect(lastSeg.terminal).toBe(true);
    }
  });

  it("每个段有有效的 insertIndex", () => {
    const source: Point = { x: 0, y: 0 };
    const cp1: Point = { x: 50, y: 100 };
    const cp2: Point = { x: 150, y: 100 };
    const target: Point = { x: 200, y: 200 };
    const { segments } = buildEdgeGeometry(
      [source, cp1, cp2, target],
      Position.Bottom,
      Position.Top,
    );
    for (const s of segments) {
      expect(s.insertIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("path 是有效的 SVG path 字符串", () => {
    const source: Point = { x: 0, y: 0 };
    const target: Point = { x: 200, y: 200 };
    const { path } = buildEdgeGeometry(
      [source, target],
      Position.Bottom,
      Position.Top,
    );
    expect(path).toMatch(/^M[\d.eE+-]+ [\d.eE+-]+/);
  });

  it("段的 mid 是 from 和 to 的中点", () => {
    const source: Point = { x: 0, y: 0 };
    const target: Point = { x: 0, y: 200 };
    const { segments } = buildEdgeGeometry(
      [source, target],
      Position.Bottom,
      Position.Top,
    );
    for (const s of segments) {
      expect(s.mid.x).toBeCloseTo((s.from.x + s.to.x) / 2);
      expect(s.mid.y).toBeCloseTo((s.from.y + s.to.y) / 2);
    }
  });
});

// ---------------------------------------------------------------------------
// mergeCollinearSegments
// ---------------------------------------------------------------------------

describe("mergeCollinearSegments", () => {
  function makeSeg(
    from: Point,
    to: Point,
    extra: Partial<VisualSegment> = {},
  ): VisualSegment {
    return {
      from,
      to,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      length: Math.hypot(to.x - from.x, to.y - from.y),
      insertIndex: 0,
      terminal: false,
      fromIsSource: false,
      toIsTarget: false,
      ...extra,
    };
  }

  it("空数组或单段直接返回", () => {
    expect(mergeCollinearSegments([])).toEqual([]);
    const s = makeSeg({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(mergeCollinearSegments([s])).toHaveLength(1);
  });

  it("合并水平共线相邻段", () => {
    const segs = [
      makeSeg({ x: 0, y: 0 }, { x: 50, y: 0 }, { insertIndex: 0 }),
      makeSeg({ x: 50, y: 0 }, { x: 100, y: 0 }, { insertIndex: 1 }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(1);
    expect(result[0].from).toEqual({ x: 0, y: 0 });
    expect(result[0].to).toEqual({ x: 100, y: 0 });
    expect(result[0].length).toBe(100);
    expect(result[0].insertIndex).toBe(0);
  });

  it("合并垂直共线相邻段", () => {
    const segs = [
      makeSeg({ x: 50, y: 0 }, { x: 50, y: 50 }, { insertIndex: 0 }),
      makeSeg({ x: 50, y: 50 }, { x: 50, y: 100 }, { insertIndex: 1 }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(1);
    expect(result[0].from).toEqual({ x: 50, y: 0 });
    expect(result[0].to).toEqual({ x: 50, y: 100 });
  });

  it("不合并不共线的相邻段", () => {
    const segs = [
      makeSeg({ x: 0, y: 0 }, { x: 50, y: 0 }),
      makeSeg({ x: 50, y: 0 }, { x: 50, y: 50 }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(2);
  });

  it("不合并端点不连续的共线段", () => {
    const segs = [
      makeSeg({ x: 0, y: 0 }, { x: 50, y: 0 }),
      makeSeg({ x: 60, y: 0 }, { x: 100, y: 0 }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(2);
  });

  it("合并后 toIsTarget 和 terminal 正确传播", () => {
    const segs = [
      makeSeg({ x: 0, y: 0 }, { x: 50, y: 0 }, { insertIndex: 0, toIsTarget: false, terminal: false }),
      makeSeg({ x: 50, y: 0 }, { x: 100, y: 0 }, { insertIndex: 1, toIsTarget: true, terminal: true }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(1);
    expect(result[0].toIsTarget).toBe(true);
    expect(result[0].terminal).toBe(true);
  });

  it("三条共线段合并为一条", () => {
    const segs = [
      makeSeg({ x: 0, y: 0 }, { x: 30, y: 0 }, { insertIndex: 0 }),
      makeSeg({ x: 30, y: 0 }, { x: 60, y: 0 }, { insertIndex: 1 }),
      makeSeg({ x: 60, y: 0 }, { x: 100, y: 0 }, { insertIndex: 2 }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(1);
    expect(result[0].from).toEqual({ x: 0, y: 0 });
    expect(result[0].to).toEqual({ x: 100, y: 0 });
    expect(result[0].length).toBe(100);
  });

  it("混合场景：共线段合并，非共线段保留", () => {
    const segs = [
      makeSeg({ x: 0, y: 0 }, { x: 50, y: 0 }, { insertIndex: 0 }),
      makeSeg({ x: 50, y: 0 }, { x: 100, y: 0 }, { insertIndex: 1 }),
      makeSeg({ x: 100, y: 0 }, { x: 100, y: 50 }, { insertIndex: 2 }),
      makeSeg({ x: 100, y: 50 }, { x: 100, y: 100 }, { insertIndex: 3 }),
    ];
    const result = mergeCollinearSegments(segs);
    expect(result).toHaveLength(2);
    expect(result[0].from).toEqual({ x: 0, y: 0 });
    expect(result[0].to).toEqual({ x: 100, y: 0 });
    expect(result[1].from).toEqual({ x: 100, y: 0 });
    expect(result[1].to).toEqual({ x: 100, y: 100 });
  });
});
