import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolInput } from "./ToolInput";
import { ToolOutput } from "./ToolOutput";

vi.mock("../markdown/ai-elements/code-block", () => ({ CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> }));
afterEach(cleanup);

it("hides empty parameters and retains meaningful values", () => {
  const view = render(<><ToolInput input={{}} /><ToolOutput output={{}} /></>);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<ToolInput input={{ path: "src/main.ts", offset: 0, readonly: false }} />);
  expect(screen.getByRole("heading", { name: "Parameters" })).toBeVisible();
  expect(view.container).toHaveTextContent('"path": "src/main.ts"');
  expect(view.container).toHaveTextContent('"offset": 0');
  expect(view.container).toHaveTextContent('"readonly": false');
  view.rerender(<ToolOutput output={{}} errorText="本次操作未完成" />);
  expect(screen.getByText("本次操作未完成")).toBeVisible();
});
