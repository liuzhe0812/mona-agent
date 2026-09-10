import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usePendingQueue } from "@/hooks/usePendingQueue";

describe("usePendingQueue", () => {
  it("starts with an empty queue", () => {
    const { result } = renderHook(() => usePendingQueue());
    expect(result.current.messages).toEqual([]);
  });

  it("enqueues a message", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("hello");
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("hello");
    expect(result.current.messages[0].id).toBeTruthy();
  });

  it("preserves images until the pending message is appended", () => {
    const { result } = renderHook(() => usePendingQueue());
    const images = [{
      media: { data_url: "data:image/png;base64,AAAA", name: "followup.png" },
      preview: { url: "data:image/png;base64,AAAA", name: "followup.png" },
    }];

    act(() => {
      result.current.enqueue("look at this", images);
    });

    expect(result.current.messages[0].images).toEqual(images);
  });

  it("preserves the active Office context until the pending message is appended", () => {
    const { result } = renderHook(() => usePendingQueue());

    act(() => {
      result.current.enqueue("继续修改", undefined, {
        officeSessionId: "office_123",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      });
    });

    expect(result.current.messages[0].options).toMatchObject({
      officeSessionId: "office_123",
      officeDocumentType: "slides",
      officeDisplayName: "季度汇报.pptx",
    });
  });

  it("respects the max limit of 3", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
      result.current.enqueue("c");
    });
    expect(result.current.messages).toHaveLength(3);
    let returned: boolean;
    act(() => {
      returned = result.current.enqueue("d");
    });
    expect(returned).toBe(false);
    expect(result.current.messages).toHaveLength(3);
  });

  it("removes a message by id", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
    });
    const id = result.current.messages[0].id;
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("b");
  });

  it("updates a message content by id", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("original");
    });
    const id = result.current.messages[0].id;
    act(() => {
      result.current.update(id, "edited");
    });
    expect(result.current.messages[0].content).toBe("edited");
  });

  it("clears all messages", () => {
    const { result } = renderHook(() => usePendingQueue());
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.messages).toEqual([]);
  });
});
