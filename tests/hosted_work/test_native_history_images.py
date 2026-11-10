"""Keep unique image pixels and every message while referencing exact repeats."""
import copy

from mona.providers.native_work_provider import native_history_input


def test_repeated_history_image_is_referenced_without_mutating_or_losing_messages():
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,same-pixels", "detail": "high"}}
    messages = [{"role": "tool", "tool_call_id": "old-inspect", "content": [image]},
                {"role": "user", "content": [{"type": "text", "text": "请根据这张图继续"}, copy.deepcopy(image)]}]
    before = copy.deepcopy(messages)
    blocks = native_history_input(messages)
    assert [b for b in blocks if b["type"] == "image_url"] == [image]
    text = "\n".join(b["text"] for b in blocks if b["type"] == "text")
    assert "old-inspect" in text and "请根据这张图继续" in text and "前文图像 1 完全相同" in text
    assert messages == before


def test_different_pixels_or_detail_keep_their_original_image_blocks():
    images = [{"type": "image_url", "image_url": {"url": url, "detail": detail}}
              for url, detail in [("data:image/png;base64,one", "high"),
                                  ("data:image/png;base64,two", "high"),
                                  ("data:image/png;base64,one", "low")]]
    blocks = native_history_input([{"role": "user", "content": images}])
    assert [b for b in blocks if b["type"] == "image_url"] == images
