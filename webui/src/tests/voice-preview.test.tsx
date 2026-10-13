import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {VoicePreviewButton} from "@/components/doc/video/VoicePreviewButton";
import {ApiError, fetchVoicePreviewBytes} from "@/lib/api";

vi.mock("@/providers/ClientProvider", () => ({useClient: () => ({token: "fixture"})}));
vi.mock("@/lib/api", async (original) => ({...await original<typeof import("@/lib/api")>(), fetchVoicePreviewBytes: vi.fn()}));

const audio = {play: vi.fn(async () => {}), pause: vi.fn(), onended: null, onerror: null};

describe("voice choice preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("Audio", vi.fn(function () {return audio;}));
    URL.createObjectURL = vi.fn(() => "blob:voice");
    URL.revokeObjectURL = vi.fn();
    vi.mocked(fetchVoicePreviewBytes).mockResolvedValue(new Blob(["audio"]));
  });

  it("auditions current draft voice/rate and stops when the choice changes", async () => {
    const view = render(<VoicePreviewButton provider="edge" voice="voice-a" rate="+10%" />);
    fireEvent.click(screen.getByRole("button", {name: "试音"}));
    await screen.findByRole("button", {name: "停止试音"});
    expect(fetchVoicePreviewBytes).toHaveBeenCalledWith("fixture", {ttsProvider: "edge", ttsVoice: "voice-a", ttsRate: "+10%"}, expect.any(AbortSignal));
    view.rerender(<VoicePreviewButton provider="edge" voice="voice-b" rate="+10%" />);
    expect(audio.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice");
    expect(screen.getByRole("button", {name: "试音"})).toBeEnabled();
  });

  it("ignores and cancels a late response after the voice is changed", async () => {
    let resolve!: (blob: Blob) => void;
    vi.mocked(fetchVoicePreviewBytes).mockReturnValue(new Promise((ready) => {resolve = ready;}));
    const view = render(<VoicePreviewButton provider="edge" voice="voice-a" rate="+0%" />);
    fireEvent.click(screen.getByRole("button", {name: "试音"}));
    const signal = vi.mocked(fetchVoicePreviewBytes).mock.calls[0][2]!;
    view.rerender(<VoicePreviewButton provider="edge" voice="voice-b" rate="+0%" />);
    expect(signal.aborted).toBe(true);
    resolve(new Blob(["old-voice"]));
    await waitFor(() => expect(screen.getByRole("button", {name: "试音"})).toBeEnabled());
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("reports the actual component remedy", async () => {
    vi.mocked(fetchVoicePreviewBytes).mockRejectedValue(new ApiError(503, "配音组件未准备好，请更新应用。", "TTS_COMPONENT_MISSING"));
    const view = render(<VoicePreviewButton provider="edge" voice="voice-a" rate="+0%" />);
    fireEvent.click(screen.getByRole("button", {name: "试音"}));
    const dialog = await screen.findByRole("dialog", {name: "试音未能播放"});
    expect(dialog).toHaveTextContent("配音组件未准备好");
    view.unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("releases playing audio when the settings close", async () => {
    const view = render(<VoicePreviewButton provider="edge" voice="voice-a" rate="+0%" />);
    fireEvent.click(screen.getByRole("button", {name: "试音"}));
    await screen.findByRole("button", {name: "停止试音"});
    view.unmount();
    expect(audio.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice");
  });
});
