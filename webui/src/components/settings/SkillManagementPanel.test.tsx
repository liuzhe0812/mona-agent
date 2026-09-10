import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  getSkillLifecycleConfig: vi.fn(),
  archiveSkill: vi.fn(),
  updateSkillLifecycleConfig: vi.fn(),
  pruneSkills: vi.fn(),
  restoreSkill: vi.fn(),
  setSkillPinned: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  archiveSkill: mocks.archiveSkill,
  getSkillLifecycleConfig: mocks.getSkillLifecycleConfig,
  listSkills: mocks.listSkills,
  pruneSkills: mocks.pruneSkills,
  restoreSkill: mocks.restoreSkill,
  setSkillPinned: mocks.setSkillPinned,
  updateSkillLifecycleConfig: mocks.updateSkillLifecycleConfig,
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClientOptional: () => ({ token: "test-token" }),
}));

import { SkillManagementPanel } from "./SkillManagementPanel";

describe("SkillManagementPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSkills.mockResolvedValue({ skills: [] });
    mocks.getSkillLifecycleConfig.mockResolvedValue({
      skillPruneEnabled: false,
      archiveAfterDays: 90,
      maxActiveUserSkills: 100,
      dreamSchedule: "每 2 小时",
      scope: "per_agent",
    });
  });

  it("keeps global settings focused on self-learning and archive policy", async () => {
    render(<SkillManagementPanel />);

    expect(await screen.findByText(/全局自进化策略|自进化策略/)).toBeInTheDocument();
    expect(screen.getByText(/自动归档|归档策略/)).toBeInTheDocument();
    expect(screen.getByText("每个 Agent 的容量上限")).toBeInTheDocument();
    expect(screen.getByText(/具体技能请进入对应 Agent/)).toBeInTheDocument();
    expect(screen.queryByText("Skill 列表")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /置顶|Pin/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /归档|Archive/i })).not.toBeInTheDocument();
    expect(mocks.listSkills).not.toHaveBeenCalled();
    expect(mocks.pruneSkills).not.toHaveBeenCalled();
    expect(mocks.archiveSkill).not.toHaveBeenCalled();
    expect(mocks.restoreSkill).not.toHaveBeenCalled();
    expect(mocks.setSkillPinned).not.toHaveBeenCalled();
  });
});
