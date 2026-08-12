/** 技能矩阵热力图：行=技术领域，列=深度等级，单元格颜色=掌握度。 */

import { PROFILE_COLORS, levelColor } from "../profile-theme";
import type { SkillItem } from "@/lib/profile-api";

interface SkillMatrixProps {
  skills: SkillItem[];
}

export function SkillMatrix({ skills }: SkillMatrixProps) {
  if (!skills || skills.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-caption text-muted-foreground">
        暂无技能数据
      </div>
    );
  }

  // 按等级分组（1-5）
  const levelLabels = ["入门", "了解", "熟悉", "熟练", "精通"];
  const levelColors = [
    PROFILE_COLORS.levels[1],
    PROFILE_COLORS.cyan,
    PROFILE_COLORS.emerald,
    PROFILE_COLORS.amber,
    PROFILE_COLORS.coral,
  ];

  return (
    <div className="flex flex-col gap-1.5">
      {/* 表头 */}
      <div className="grid grid-cols-[1fr_repeat(5,28px)] items-center gap-1 text-micro text-muted-foreground">
        <span>领域</span>
        {levelLabels.map((label, i) => (
          <span
            key={label}
            className="text-center"
            style={{ color: levelColors[i] }}
          >
            {label}
          </span>
        ))}
      </div>
      {/* 矩阵 */}
      {skills.map((skill, i) => {
        const color = levelColor(skill.level);
        return (
          <div
            key={skill.area}
            className="profile-grow-x grid grid-cols-[1fr_repeat(5,28px)] items-center gap-1"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span
              className="truncate text-caption text-foreground"
              title={`${skill.area}（${skill.note_count} 篇笔记）`}
            >
              {skill.area}
            </span>
            {Array.from({ length: 5 }, (_, idx) => {
              const lvl = idx + 1;
              const filled = lvl <= skill.level;
              return (
                <div
                  key={lvl}
                  className="mx-auto h-5 w-5 rounded transition-all duration-300 hover:scale-110"
                  style={{
                    backgroundColor: filled ? color : "transparent",
                    border: `1px solid ${filled ? color : "rgba(128,128,128,0.2)"}`,
                    boxShadow: filled ? `0 0 8px ${color}40` : "none",
                  }}
                  title={`${skill.area} - ${levelLabels[lvl - 1]}`}
                />
              );
            })}
          </div>
        );
      })}
      {/* 图例 */}
      <div className="mt-2 flex items-center gap-3 text-micro text-muted-foreground">
        <span>低</span>
        <div className="flex gap-1">
          {levelColors.map((c, i) => (
            <div
              key={i}
              className="h-3 w-6 rounded-sm"
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <span>高</span>
      </div>
    </div>
  );
}
