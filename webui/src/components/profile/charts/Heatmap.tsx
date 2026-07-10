/** 24h×7d 活跃热力图（GitHub 贡献图风格）。 */

import { PROFILE_COLORS } from "../profile-theme";

interface HeatmapProps {
  /** 7 rows × 24 cols，每个值为 count */
  data: number[][];
}

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function ActivityHeatmap({ data }: HeatmapProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
        暂无活跃度数据
      </div>
    );
  }

  const max = Math.max(...data.flat(), 1);

  const cellColor = (v: number) => {
    if (v === 0) return "rgba(128,128,128,0.1)";
    const ratio = v / max;
    if (ratio > 0.75) return PROFILE_COLORS.coral;
    if (ratio > 0.5) return PROFILE_COLORS.amber;
    if (ratio > 0.25) return PROFILE_COLORS.emerald;
    return PROFILE_COLORS.emeraldSoft;
  };

  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-1">
        {/* 小时标签 */}
        <div className="flex gap-0.5 pl-10 text-[9px] text-muted-foreground">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="w-4 text-center">
              {h % 6 === 0 ? h : ""}
            </div>
          ))}
        </div>
        {/* 7 行 */}
        {data.map((row, day) => (
          <div key={day} className="flex items-center gap-1">
            <span className="w-10 shrink-0 text-[10px] text-muted-foreground">{DAYS[day]}</span>
            <div className="flex gap-0.5">
              {row.map((count, hour) => (
                <div
                  key={hour}
                  className="h-4 w-4 rounded transition-all duration-300 hover:scale-125 hover:ring-2 hover:ring-offset-1 hover:ring-offset-background"
                  style={{
                    backgroundColor: cellColor(count),
                    boxShadow: count > 0 ? `0 0 4px ${cellColor(count)}40` : "none",
                  }}
                  title={`${DAYS[day]} ${hour}:00 - ${count} 次`}
                />
              ))}
            </div>
          </div>
        ))}
        {/* 图例 */}
        <div className="mt-2 flex items-center justify-end gap-1.5 text-[9px] text-muted-foreground">
          <span>少</span>
          <div className="h-3 w-3 rounded" style={{ background: "rgba(128,128,128,0.1)" }} />
          <div className="h-3 w-3 rounded" style={{ background: PROFILE_COLORS.emeraldSoft }} />
          <div className="h-3 w-3 rounded" style={{ background: PROFILE_COLORS.emerald }} />
          <div className="h-3 w-3 rounded" style={{ background: PROFILE_COLORS.amber }} />
          <div className="h-3 w-3 rounded" style={{ background: PROFILE_COLORS.coral }} />
          <span>多</span>
        </div>
      </div>
    </div>
  );
}
