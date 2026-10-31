import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { developmentApi, type DevProject, type DevSession } from "@/lib/development-api";
import { DevelopmentOverview } from "./DevelopmentOverview";
import { useDevelopmentStore } from "./store";

vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()),
  developmentApi: { resources: vi.fn().mockResolvedValue({ rules: [], skills: [{ name: "Build guide", description: "项目 Skill 描述", path: "skills/build.md" }], issues: ["资源诊断不得出现在摘要"] }) } }));
vi.mock("./DevelopmentCollaboration", () => ({ DevelopmentCollaboration: () => <section aria-label="开发子智能体">子智能体</section> }));
vi.mock("./DevelopmentGitTools", () => ({ DevelopmentGitTools: () => <section aria-label="Git 工具">Git rows</section> }));
const project: DevProject = { id: "project_overview", rootPath: "D:/project", displayName: "项目", lastOpenedAt: "" };
const session: DevSession = { id: "dev_overview", projectId: project.id, executor: "codex", title: "任务", model: "gpt-test",
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
beforeEach(() => { useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("replaces only the selected block and uses shared tooltips for project and Skill details", async () => {
  useDevelopmentStore.getState().setSnapshot(session.id, { session, messages: [], before: null, messageCount: 0,
    runs: [{ id: "run", sessionId: session.id, executor: "codex", status: "unknown", revision: 1, createdAt: "2026-10-01T00:00:00Z", finishedAt: null }],
    events: [], eventCursor: 0, pendingInputs: [], live: null,
    plan: { runId: "run", plan: [{ step: "额外摘要内容", status: "pending" }] } });
  const view = render(<DevelopmentOverview project={project} session={session} executors={[]} onOpenTool={vi.fn()} />);
  const projectTitle = screen.getByRole("heading", { level: 3, name: "项目" });
  expect(projectTitle).not.toHaveAttribute("title");
  expect(view.container.querySelectorAll("[title]")).toHaveLength(0);
  expect(screen.getByRole("region", { name: "Git 工具" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "开发子智能体" })).toBeInTheDocument();
  expect(screen.getByText("项目规则与 Skills")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "任务待办" })).toHaveTextContent("额外摘要内容");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/未收到任务完成结果|停止任务|结束等待并继续|恢复任务|资源诊断不得出现在摘要|gpt-test|本轮结束|已工作/)).toBeNull();
  const skill = await screen.findByRole("button", { name: "Build guide" });
  expect(skill).not.toHaveAttribute("title");
  const user = userEvent.setup();
  await user.hover(projectTitle);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(project.rootPath);
  await user.unhover(projectTitle);
  await user.click(screen.getByText("项目规则与 Skills"));
  await user.hover(skill);
  expect((await screen.findAllByText("项目 Skill 描述")).length).toBeGreaterThan(0);
});

it("keeps resource loading errors out of the summary and logs only the error category", async () => {
  vi.mocked(developmentApi.resources).mockRejectedValueOnce(new Error("D:/private/project"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<DevelopmentOverview project={project} session={session} executors={[]} onOpenTool={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "任务待办" })).toBeNull();
  await waitFor(() => expect(warning).toHaveBeenCalledWith("[DevelopmentOverview] project resources unavailable", "Error"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("D:/private/project")).toBeNull();
});
