---
name: mona-office
description: "Legacy OfficeCLI compatibility for already-installed environments. Do not use for new Office editing tasks; Mona no longer distributes OfficeCLI."
---

# Mona Office Document Collaboration

> Legacy compatibility only. Do not start new tasks with this Skill and do not ask
> users to install OfficeCLI. Existing tasks may finish only when the binary is
> already present.

## Overview

The `office` tool wraps [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) to give the
agent a structured command set over `.docx`, `.xlsx`, and `.pptx` files. It operates
on a **working copy** for mutations so the user's original file is never modified.

## When to Use

- User asks to **modify** an Office document (add/remove/set content, reorder slides, etc.)
- User asks to **inspect** the structure of an Office document
- User asks to **validate** an Office document's OpenXML schema

For **content extraction / Q&A** (read-only summarization, "what does this PDF say"),
prefer the `document` tool — it handles PDF, CSV, and plain text too.

## Tool Actions

| Action | Mutating | Description |
|--------|----------|-------------|
| `inspect` | No | Get the document structure tree (`officecli get <file> /`) |
| `query` | No | Query elements with CSS-like selectors (`p`, `slide[1] shape`, …) |
| `view` | No | View in outline/content/raw mode |
| `get` | No | Get a specific node by path (e.g. `/body/p[1]`) |
| `validate` | No | Validate against OpenXML schema |
| `batch` | **Yes** | Execute a list of mutating commands atomically on a working copy |

## Standard Workflow

1. **Inspect** the document to understand its structure:
   ```json
   {"action": "inspect", "path": "uploads/<chat_id>/abc-report.docx"}
   ```

2. **Query** specific elements if needed:
   ```json
   {"action": "query", "path": "...", "selector": "p"}
   ```

3. **Explain the plan to the user** in plain language before batching. List
   each intended change as a short bullet so the user can follow along:
   - "Set the first paragraph text to 'New heading'"
   - "Append a new paragraph after the body"
   This makes the modification process **white-box** — the user sees what the
   agent is about to do, not just the final result. Do not skip this step even
   for small edits.

4. **Batch** the desired edits (each item is one command):
   ```json
   {
     "action": "batch",
     "path": "uploads/<chat_id>/abc-report.docx",
     "commands": [
       {"command": "set", "path": "/body/p[1]", "props": {"text": "New heading"}},
       {"command": "add", "parent": "/body", "type": "paragraph", "props": {"text": "Appended paragraph"}}
     ]
   }
   ```
   The tool returns the `working_copy` path — subsequent reads/writes on the same
   source file reuse that working copy so edits accumulate across turns.

5. **Validate** the working copy to confirm structural integrity:
   ```json
   {"action": "validate", "path": "uploads/office/<uuid>-abc-report.docx"}
   ```

6. **Deliver** the modified file to the user:
   ```json
   {"tool": "deliver_file", "path": "uploads/office/<uuid>-abc-report.docx"}
   ```

7. **Summarize what was changed** in the reply text — the user should be able
   to verify each bullet from step 3 against the delivered file without opening
   it. If any command's effect differed from the plan, call it out explicitly.

## Batch Command Reference

Each item in `commands` is an object whose `command` field is the bare verb:

| Verb | Required fields | Optional fields |
|------|----------------|-----------------|
| `set` | `path` | `props` |
| `add` | `parent`, `type` | `props` |
| `remove` | `path` | — |
| `move` | `path`, `to` | `after`, `before` |
| `swap` | `path`, `path2` | — |

`props` is a key→string map. Common property names by format:

- **docx** (paragraph): `text`, `bold`, `italic`, `style`, `align`
- **xlsx** (cell): `value`, `formula`, `bold`, `number_format`
- **pptx** (shape): `text`, `x`, `y`, `width`, `height`, `fill`, `font_size`

For the full schema reference, run `officecli help <format>` on the user's machine
via the `exec` tool (e.g. `officecli help docx`).

## Safety Guarantees

1. **Original file is never modified.** The first `batch` call copies the source
   to `workspace/uploads/office/<uuid>-<name>`; all subsequent mutations target
   that copy.
2. **Paths are workspace-confined.** The tool resolves every path against the
   active workspace and rejects absolute paths or `..` traversal.
3. **Output is capped** at 50 000 chars to protect the context window.
4. **Batch is atomic.** OfficeCLI's `batch` command applies all items in a
   single open/save cycle; if one fails, the document state is rolled back.

## Limitations (Phase B)

- No inline collaborative editing — the user reviews the modified file via
  `deliver_file`, not a live preview.
- No propose/confirm flow — edits apply immediately to the working copy.
  The agent explains the plan in step 3 and summarizes in step 7 to keep the
  process white-box; the user can reject by ignoring the delivered file, or
  ask for further edits in the next turn.
- No snapshot/undo — each `batch` overwrites the working copy in place. If
  the user wants to revert, they must re-import the original file.
- **Conflict detection** — if the user opens the working copy in system Office
  and saves external changes, the next `batch` is refused with an error.
  Tell the user what happened and ask whether to re-import the original or
  re-apply the agent's changes on top of the externally-modified state.
- No automatic refresh of an open system Office window — the user must
  re-open the delivered file.
