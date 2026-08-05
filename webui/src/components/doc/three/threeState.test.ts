import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STATUS_LABELS,
  STAGE_LABELS,
  fetchProjectState,
  projectFileUrl,
} from "./threeState";

vi.mock("@/lib/api", () => ({
  getServicesHttpBase: vi.fn().mockResolvedValue("http://gw"),
}));

describe("projectFileUrl", () => {
  it("builds an encoded file URL", () => {
    const url = projectFileUrl("http://svc", "我的项目", "references/front view.png");
    expect(url).toBe(
      "http://svc/api/three/project/file?name=%E6%88%91%E7%9A%84%E9%A1%B9%E7%9B%AE&path=references%2Ffront%20view.png",
    );
  });
});

describe("fetchProjectState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches and parses the aggregate state", async () => {
    const payload = {
      name: "p1",
      specPresent: true,
      stages: [{ id: "blockout", status: "running" }],
      blockedReason: "",
      components: [],
      references: [],
      renders: [],
      comparisons: [],
      candidatePresent: false,
      sourcePresent: false,
      lastReview: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }),
    );
    const state = await fetchProjectState("p1");
    expect(state.name).toBe("p1");
    expect(state.stages[0].status).toBe("running");
    expect(fetch).toHaveBeenCalledWith(
      "http://gw/api/three/project?name=p1",
      expect.anything(),
    );
  });

  it("throws on HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchProjectState("p1")).rejects.toThrow("HTTP 500");
  });
});

describe("labels", () => {
  it("has a label for every default pass", () => {
    for (const id of [
      "blockout",
      "structural-pass",
      "form-refinement",
      "material-pass",
      "surface-pass",
      "lighting-pass",
      "interaction-pass",
      "optimization-pass",
    ]) {
      expect(STAGE_LABELS[id]).toBeTruthy();
    }
  });

  it("has a label for every stage status", () => {
    for (const s of ["pending", "running", "review", "passed", "failed", "blocked"] as const) {
      expect(STATUS_LABELS[s]).toBeTruthy();
    }
  });
});
