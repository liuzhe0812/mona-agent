# DOCX 高级离线操作参考

本参考继承原 docx Skill 的 OOXML、修订、批注和离线生成方法，原许可标记为 Proprietary。仅在 mona-docx 已确认实时 Office 不支持所需操作时读取。

## 从实时会话切换

- 参数校验失败、版本冲突或指定页未显示不证明编辑能力缺失；先检查具体操作能力，修正调用或重新读取目标。
- 活动文档先按最新版本导出任务副本，保留原文件。不得直接修改编辑器的 working.docx 或旧磁盘副本。
- 离线处理使用不同输出路径。重新交付前检查会话版本；若用户已继续编辑，不得把旧导出结果覆盖回当前会话。
- 处理后用 office open(path=...) 打开结果副本，读取受影响内容并检查实际版式。这属于离线结果复核，不宣称修改过程为实时编辑；原会话与结果副本的区别需说明。
- 页数、末页空白、修订或批注效果必须有相应检查证据。解包、打包成功不等于任务完成；无法验证时明确说明。
- Python 辅助脚本统一通过 skill_script_run，skill="mona-docx"。依赖使用统一受管运行时，禁止另建下载器或使用系统 Python。不要猜测不存在的脚本名。工具执行目录是 Skill 目录，下面示例中的文件参数必须替换为已确认位于任务工作区内的绝对路径，并对包含空格的参数加引号。

## 内容索引

- 读取、版式观察和接受常见修订：下方快速参考。
- 精确 XML 修改、修订、批注：Editing Existing Documents / XML Reference。

## 快速参考

| 任务 | 方式 |
|------|------|
| 新建、读取、编辑或观察 DOCX | 通过 `office` 打开并使用 `inspect`、`apply` 或 `visual`；内容和版式以当前会话为准 |
| 已有 PDF 的页面画面 | 使用 Mona 的 `pdf` 工具渲染页面 |
| 高级 XML 修改 | 经 `unpack.py` 解包副本，编辑后用 `pack.py` 生成新的 DOCX |

旧版 `.doc` 当前不支持直接编辑，不能宣称已转换。上述工具不提供 DOCX 到 PDF 的转换。

### 接受常见修订

`accept_changes.py` 使用 Mona 统一运行时处理段落内的文本插入、删除、移动，以及原有格式属性的修订历史。它保留当前格式，并对正文、页眉、页脚及其他 Word XML 部件逐一检查。输入与新输出必须都在当前工作区，输出不能已存在：

```text
skill_script_run(skill="mona-docx", script="accept_changes.py", args='"<工作区内源文件.docx>" "<工作区内新文件.docx>"')
```

段落标记、表格行/单元格、字段/对象、跨段移动范围等复杂修订不受支持：脚本会报错且不创建输出。不能把本脚本视为支持所有 Word 修订；处理后重新用 Office 打开副本并验收内容与版式。

---

## Editing Existing Documents

For ordinary edits in Mona, use the live `office` session described above. The following section is for advanced features that the editor does not support, such as tracked changes, comments, or exact raw OOXML preservation.

**This section describes raw XML editing with the unpack/pack workflow. XML entities such as `&#x201C;` are valid in XML text.**

**Follow all 3 steps in order.**

### Step 1: Unpack
```bash
skill_script_run(skill="mona-docx", script="unpack.py", args="document.docx unpacked/ --merge-runs false --simplify-redlines false")
```
Extracts XML, pretty-prints, and converts smart quotes to XML entities (`&#x201C;` etc.). The example disables run merging and revision simplification to preserve unrelated structure; enable those transformations only when the task requires them.

### Step 2: Edit XML

Edit files in `unpacked/word/`. See XML Reference below for patterns.

**Use "AI Assistant" as the author** for tracked changes and comments, unless the user explicitly requests use of a different name.

Use Mona's `apply_patch` for localized XML changes, with paths relative to the active workspace. Inspect the exact target first and preserve unrelated XML; do not rewrite the entire document for a local repair.

**CRITICAL: Use smart quotes for new content.** When adding text with apostrophes or quotes, use XML entities to produce smart quotes:
```xml
<!-- Use these entities for professional typography -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```
| Entity | Character |
|--------|-----------|
| `&#x2018;` | ‘ (left single) |
| `&#x2019;` | ’ (right single / apostrophe) |
| `&#x201C;` | “ (left double) |
| `&#x201D;` | ” (right double) |

**Adding comments:** Use `comment.py` to handle boilerplate across multiple XML files (text must be pre-escaped XML):
```bash
skill_script_run(skill="mona-docx", script="comment.py", args='unpacked/ 0 "Comment text with &amp; and &#x2019;"')
skill_script_run(skill="mona-docx", script="comment.py", args='unpacked/ 1 "Reply text" --parent 0')
skill_script_run(skill="mona-docx", script="comment.py", args='unpacked/ 0 "Text" --author "Custom Author"')
```
Then add markers to document.xml (see Comments in XML Reference).

### Step 3: Pack
```bash
skill_script_run(skill="mona-docx", script="pack.py", args="unpacked/ output.docx --original document.docx")
```
Validates with auto-repair, condenses XML, and creates DOCX. 提供 `--original` 才会运行此入口的验证；正常交付不得跳过验证。

**Auto-repair will fix:**
- `durableId` >= 0x7FFFFFFF (regenerates valid ID)
- Missing `xml:space="preserve"` on `<w:t>` with whitespace

**Auto-repair won't fix:**
- Malformed XML, invalid element nesting, missing relationships, schema violations

### Common Pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings. Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block into your tracked change runs to maintain bold, font size, etc.

---

## XML Reference

### Schema Compliance

- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`, `<w:ind>`, `<w:jc>`, `<w:rPr>` last
- **Whitespace**: Add `xml:space="preserve"` to `<w:t>` with leading/trailing spaces
- **RSIDs**: Must be 8-digit hex (e.g., `00AB1234`)

### Tracked Changes

**Insertion:**
```xml
<w:ins w:id="1" w:author="AI Assistant" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**
```xml
<w:del w:id="2" w:author="AI Assistant" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Inside `<w:del>`**: Use `<w:delText>` instead of `<w:t>`, and `<w:delInstrText>` instead of `<w:instrText>`.

**Minimal edits** - only mark what changes:
```xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="AI Assistant" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="AI Assistant" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting entire paragraphs/list items** - when removing ALL content from a paragraph, also mark the paragraph mark as deleted so it merges with the next paragraph. Add `<w:del/>` inside `<w:pPr><w:rPr>`:
```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="AI Assistant" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="AI Assistant" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```
Without the `<w:del/>` in `<w:pPr><w:rPr>`, accepting changes leaves an empty paragraph/list item.

**Rejecting another author's insertion** - nest deletion inside their insertion:
```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="AI Assistant" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
```

**Restoring another author's deletion** - add insertion after (don't modify their deletion):
```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="AI Assistant" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
```

### Comments

After running `comment.py` (see Step 2), add markers to document.xml. For replies, use `--parent` flag and nest markers inside the parent's.

**CRITICAL: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of `<w:r>`, never inside `<w:r>`.**

```xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="AI Assistant" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- Comment 0 with reply 1 nested inside -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### Images

1. Add image file to `word/media/`
2. Add relationship to `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
```
3. Add content type to `[Content_Types].xml`:
```xml
<Default Extension="png" ContentType="image/png"/>
```
4. Reference in document.xml:
```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

---

## Dependencies

辅助脚本使用 Mona 统一运行时中的 `defusedxml` 和 `lxml`，无需另装应用或命令行工具。
