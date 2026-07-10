---
name: "tiptap-dev"
description: "TipTap v3 富文本编辑器开发避坑指南。Invoke when developing TipTap editor features, debugging task list/checkbox issues, or customizing node rendering."
---

# TipTap v3 开发避坑

## 1. NodeView 不继承 renderHTML 的属性（最高频坑）

**症状**：CSS 按 `renderHTML` 里的属性写选择器，但 NodeView 渲染路径下 DOM 上没有该属性。

**根因**：TipTap v3 的 `addNodeView()` 路径**不会自动应用** `renderHTML` 里写死的属性。只有 `HTMLAttributes` 选项里的属性才会被 NodeView 通过 `setAttribute` 写到 DOM。

**案例**：`@tiptap/extension-task-item` 的 `renderHTML` 写了 `"data-type": this.name`，但 NodeView 路径只遍历 `this.options.HTMLAttributes` 设置属性，默认 `HTMLAttributes: {}` 为空，所以 `<li>` 上只有 `data-checked`，**没有 `data-type="taskItem"`**。

**修复**：在 `configure` 时显式注入需要的属性：

```typescript
TaskItem.configure({
  nested: true,
  HTMLAttributes: { "data-type": "taskItem" },
}),
```

**排查方法**：F12 → Console 打印实际 DOM：
```javascript
document.querySelectorAll(".ProseMirror li").forEach((li, i) => {
  console.log(`li[${i}]:`, li.getAttribute("data-type"), li.outerHTML.slice(0, 200));
});
```

## 2. TaskItem DOM 结构

NodeView 渲染的 HTML（与 `renderHTML` 返回的结构一致）：

```html
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="false">
    <label contenteditable="false">
      <input type="checkbox">
      <span></span>
    </label>
    <div>
      <p>任务文字</p>
    </div>
  </li>
</ul>
```

- `li` 是 flex 容器，`label`（checkbox 容器）和 `div`（内容）是两个 flex 子项
- `label` 上 `contenteditable="false"`，checkbox 的 mousedown 被 preventDefault
- `span` 是样式占位，默认 `display: none` 即可

## 3. Checkbox 对齐方案（已验证可用）

```css
.ProseMirror li[data-type="taskItem"] {
  display: flex !important;
  align-items: center !important;
  gap: 0.5rem !important;
  min-height: 1.5rem !important;
}
.ProseMirror li[data-type="taskItem"] > label {
  flex: 0 0 auto !important;
  user-select: none !important;
  display: inline-flex !important;
  align-items: center !important;
  height: 1.5rem !important;
}
.ProseMirror li[data-type="taskItem"] > label input[type="checkbox"] {
  margin: 0 !important;
  width: 1rem !important;
  height: 1rem !important;
}
.ProseMirror li[data-type="taskItem"] > label span {
  display: none !important;
}
.ProseMirror li[data-type="taskItem"] > div {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  display: flex !important;
  align-items: center !important;
  min-height: 1.5rem !important;
}
.ProseMirror li[data-type="taskItem"] > div > p {
  margin: 0 !important;
  line-height: 1.5rem !important;
}
```

**关键点**：
- `align-items: center` 而非 `flex-start`（后者导致 checkbox 偏上）
- checkbox 固定 `1rem × 1rem`，label 固定 `height: 1.5rem`
- 文字 `line-height: 1.5rem` 与 label 等高，视觉居中

## 4. Tailwind preflight 吃掉列表标记

Tailwind preflight 设 `ul, ol { list-style: none }`，导致普通列表的 `disc/decimal` 标记消失。

**修复**：在 globals.css 中（**不放在 `@layer`**，避免被 purge 且确保优先级高于 preflight）：

```css
.notes-prosemirror ul:not([data-type="taskList"]) {
  list-style-type: disc !important;
  padding-left: 1.4rem !important;
}
.notes-prosemirror ol:not([data-type="taskList"]) {
  list-style-type: decimal !important;
  padding-left: 1.4rem !important;
}
.notes-prosemirror ul[data-type="taskList"],
.notes-prosemirror ol[data-type="taskList"] {
  list-style: none !important;
  padding-left: 0 !important;
}
```

`:not([data-type="taskList"])` 避免影响任务列表。

## 5. Tailwind arbitrary value 选择器会覆盖 CSS

`EditorContent` 的 `className` 里用 `[&_.ProseMirror_p]:my-1.5` 这类 Tailwind 任意值选择器，会编译成 `.parent .ProseMirror p { margin: 6px 0 }`，**应用到所有 `<p>`**，包括 TaskItem 内的 `<p>`。

**排查**：在 DevTools → Elements 面板选中元素，看 Computed 面板里哪条规则生效。

**修复**：
- 要么在 globals.css 用 `!important` 覆盖
- 要么在 `<style>` 标签里用更高优先级选择器
- 推荐用 React 组件内联 `<style>` 标签（见下条）

## 6. globals.css 在 Tauri WebView2 里 HMR 不可靠

**症状**：修改 `globals.css`，Vite 已正确 serve（`curl http://127.0.0.1:9527/src/globals.css` 能查到新内容），但 Tauri WebView2 不更新，重启也无效。

**根因**：疑似 WebView2 的 CSS HMR 与 Vite 集成有问题。

**规避方案**：把关键样式直接写在 React 组件里的 `<style>` 标签内，HMR 必定生效：

```tsx
<div>
  <style>{`
    .ProseMirror li[data-type="taskItem"] { ... }
  `}</style>
  <EditorContent editor={editor} />
</div>
```

**调试验证技巧**：临时加 `outline: 2px solid red` 到目标选择器，红框出现 = CSS 到达 DOM；红框不出现 = 选择器没匹配（检查 `data-type` 等属性是否真的在 DOM 上）。

## 7. onUpdate 里同步 setState 触发渲染警告

TipTap 的 `onUpdate` 回调在 ProseMirror 内部更新流程中执行，此时同步调用父组件 setState 会触发 React 警告：`Cannot update a component while rendering a different component`。

**修复**：用 `queueMicrotask` 延迟到当前渲染后：

```typescript
onUpdate: ({ editor }) => {
  const md = editor.getMarkdown();
  queueMicrotask(() => onContentChangeRef.current({ contentMarkdown: md, ... }));
},
```

## 8. 扩展版本与包结构

Mona 项目用的版本（截至 2026-07）：
- `@tiptap/extension-list`: 含 TaskList/TaskItem/ListItem 等
- `@tiptap/extension-task-item` v3.23.6: 只是 re-export `@tiptap/extension-list` 的 TaskItem，无独立实现
- `@tiptap/react`: `useEditor` + `EditorContent`
- `@tiptap/markdown`: Markdown 序列化

**查源码路径**：`node_modules/@tiptap/extension-list/dist/task-item/index.js` 是 TaskItem 真正实现，含 `addNodeView()`。

## 9. 图片资产的 Markdown 序列化

默认 Image 扩展把 src 序列化为 data URL，体积大且不可复用。自定义 `extend` 覆写 `serialize`：

```typescript
const NoteImage = TiptapImage.extend({
  addStorage() {
    return {
      markdown: {
        serialize: {
          image(state, node) {
            const src = node.attrs.title || node.attrs.alt || node.attrs.src;
            state.write(`![${node.attrs.alt || ""}](${src})`);
          },
        },
      },
    };
  },
});
```

存 `assets/xxx.png` 到 `attrs.title`，渲染时用 `convertFileSrc` 转 `asset://` 协议。

## 10. Wiki Link 自动补全

[[wiki link]] 的补全逻辑：监听 `[` 键，检测光标前是否有未闭合的 `[[`，弹出补全弹窗。TipTap 可视化模式下用 ProseMirror 的 `tr.replaceWith` 插入自定义 `wikiLink` 节点。

**光标在 link 末尾时展开**：检测光标在 wikiLink 节点末尾，用 `tr.replaceWith` 把节点替换为 `[[title]]` 纯文本，方便后续输入。
