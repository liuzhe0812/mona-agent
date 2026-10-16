import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import type { RoomAgentInfo } from "@/lib/types";

import { DiscussionDialog } from "./DiscussionDialog";


const members: RoomAgentInfo[] = [
  { id: "com.example.agent-a", displayName: "Analyst A" },
  { id: "com.example.agent-b", displayName: "Analyst B" },
  { id: "com.example.agent-c", displayName: "Analyst C" },
];


describe("DiscussionDialog", () => {
  it("requires at least two participants and a debate position for each", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<DiscussionDialog members={members} onStart={onStart} />);

    await user.click(screen.getByRole("button", { name: "Start topic" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[2]).not.toBeChecked();

    await user.click(checkboxes[1]);
    await user.type(
      screen.getByPlaceholderText(
        "For example: should a new product prioritize growth or cost control?",
      ),
      "Should we prioritize growth or profit?",
    );
    await user.click(screen.getByRole("button", { name: "Start discussion" }));
    expect(screen.getByText("Select at least two participants.")).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();

    await user.click(checkboxes[1]);
    await user.click(screen.getByRole("button", { name: "Start discussion" }));
    expect(
      screen.getByText("A debate requires a position for every participant."),
    ).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("submits the selected topic, participants, positions, rounds, and summarizer", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<DiscussionDialog members={members} onStart={onStart} />);

    await user.click(screen.getByRole("button", { name: "Start topic" }));
    expect(screen.getByText("Judge Agent (optional)")).toBeInTheDocument();
    expect(screen.getByText("No judge")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/custom|自定义/i)).not.toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText(
        "For example: should a new product prioritize growth or cost control?",
      ),
      "Should we prioritize growth or profit?",
    );
    await user.type(
      screen.getByPlaceholderText("Assign a position to Analyst A"),
      "Prioritize growth",
    );
    await user.type(
      screen.getByPlaceholderText("Assign a position to Analyst B"),
      "Prioritize profit",
    );
    await user.click(screen.getByRole("button", { name: "Debate style for Analyst A" }));
    await user.click(screen.getByRole("menuitem", { name: "Sharp punchlines" }));
    await user.click(screen.getByRole("button", { name: "Debate style for Analyst B" }));
    await user.click(screen.getByRole("menuitem", { name: "Value reframing" }));
    const rounds = screen.getByRole("spinbutton");
    fireEvent.change(rounds, { target: { value: "99" } });

    await user.click(screen.getByRole("button", { name: "Start discussion" }));

    expect(onStart).toHaveBeenCalledWith(
      "Should we prioritize growth or profit?",
      {
        mode: "debate",
        maxRounds: 99,
        participantIds: ["com.example.agent-a", "com.example.agent-b"],
        positions: {
          "com.example.agent-a": "Prioritize growth",
          "com.example.agent-b": "Prioritize profit",
        },
        styles: {
          "com.example.agent-a": "sharp_punchline",
          "com.example.agent-b": "value_reframe",
        },
        summaryAgentId: null,
      },
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("defaults each selected debater to free style when no preset is chosen", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<DiscussionDialog members={members} onStart={onStart} />);

    await user.click(screen.getByRole("button", { name: "Start topic" }));
    const analystAStyle = screen.getByRole("button", { name: "Debate style for Analyst A" });
    const analystBStyle = screen.getByRole("button", { name: "Debate style for Analyst B" });
    expect(analystAStyle).toHaveTextContent("Free style");
    expect(analystBStyle).toHaveTextContent("Free style");
    expect(screen.queryByPlaceholderText(/custom|自定义/i)).not.toBeInTheDocument();

    await user.click(analystAStyle);
    await user.click(screen.getByRole("menuitem", { name: "Simple analogies" }));
    expect(analystAStyle).toHaveTextContent("Simple analogies");
    expect(analystBStyle).toHaveTextContent("Free style");
  });

  it("passes the selected judge agent id", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<DiscussionDialog members={members} onStart={onStart} />);

    await user.click(screen.getByRole("button", { name: "Start topic" }));
    await user.type(
      screen.getByPlaceholderText(
        "For example: should a new product prioritize growth or cost control?",
      ),
      "Should we prioritize growth or profit?",
    );
    await user.type(
      screen.getByPlaceholderText("Assign a position to Analyst A"),
      "Prioritize growth",
    );
    await user.type(
      screen.getByPlaceholderText("Assign a position to Analyst B"),
      "Prioritize profit",
    );
    await user.click(screen.getByRole("button", { name: /Judge Agent/ }));
    await user.click(screen.getByRole("menuitem", { name: "Analyst C" }));
    await user.click(screen.getByRole("button", { name: "Start discussion" }));

    expect(onStart).toHaveBeenCalledWith(
      "Should we prioritize growth or profit?",
      expect.objectContaining({
        summaryAgentId: "com.example.agent-c",
        styles: {},
      }),
    );
  });

  it("uses role identities separately from debate positions and requires one for every quarrel participant", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<DiscussionDialog members={members} onStart={onStart} />);

    await user.click(screen.getByRole("button", { name: "Start topic" }));
    await user.type(
      screen.getByPlaceholderText(
        "For example: should a new product prioritize growth or cost control?",
      ),
      "Should we prioritize growth or profit?",
    );
    await user.click(screen.getByRole("button", { name: "Debate style for Analyst A" }));
    await user.click(screen.getByRole("menuitem", { name: "Sharp punchlines" }));
    await user.type(screen.getByPlaceholderText("Assign a position to Analyst A"), "Prioritize growth");
    await user.type(screen.getByPlaceholderText("Assign a position to Analyst B"), "Prioritize profit");
    await user.click(screen.getByRole("button", { name: /Quarrel/ }));

    expect(screen.getByText("No wrap-up")).toBeInTheDocument();
    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Debate style for Analyst A" })).not.toBeInTheDocument();
    const roleA = screen.getByPlaceholderText("Assign a role to Analyst A, for example: Zhang San");
    const roleB = screen.getByPlaceholderText("Assign a role to Analyst B, for example: Zhang San");
    const background = screen.getByPlaceholderText(
      "For example: Zhang San thinks Li Si took credit for his work, and they start arguing.",
    );
    expect(roleA).toHaveValue("");
    expect(roleB).toHaveValue("");
    fireEvent.change(background, { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Start discussion" }));
    expect(screen.getByText("Enter the quarrel background.")).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.change(background, { target: { value: "张三和李四因借车未还吵起来" } });
    await user.click(screen.getByRole("button", { name: "Start discussion" }));
    expect(screen.getByText("Assign a role to every participant in the quarrel.")).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
    await user.type(roleA, "Zhang San");
    await user.type(roleB, "Li Si");
    await user.click(screen.getByRole("button", { name: "Start discussion" }));

    expect(onStart).toHaveBeenCalledWith(
      "张三和李四因借车未还吵起来",
      {
        mode: "quarrel",
        maxRounds: 3,
        participantIds: ["com.example.agent-a", "com.example.agent-b"],
        positions: {},
        roles: {
          "com.example.agent-a": "Zhang San",
          "com.example.agent-b": "Li Si",
        },
        styles: {},
        summaryAgentId: null,
      },
    );
  });
});
