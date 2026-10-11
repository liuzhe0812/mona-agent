import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTimelineScroll } from "./useTimelineScroll";

afterEach(cleanup);
function Timeline({ revision }: { revision: number }) {
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), loading = useRef(false);
  const { props } = useTimelineScroll({ scrollRef: scroll, contentRef: content, followingRef: following,
    sessionKey: "test-scroll", visible: true, rowCount: 1, revision,
    onFollowingChange: () => {}, canLoadOlder: false, loadingOlder: loading, onLoadOlder: () => {} });
  return <div ref={scroll} {...props} data-testid="scroll"><div ref={content}>{revision}</div></div>;
}

describe("ZCode scrolling ownership", () => {
  it("releases follow before a delayed scroll event when the user scrolls up during a streamed update", () => {
    const view = render(<Timeline revision={0} />);
    const element = view.getByTestId("scroll");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    element.scrollTop = 760;
    fireEvent.wheel(element, { deltaY: -40 });
    // No scroll event has arrived yet: this is the race protected by the upstream state machine.
    view.rerender(<Timeline revision={1} />);
    expect(element.scrollTop).toBe(760);
  });
});
