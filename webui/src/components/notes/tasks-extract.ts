import type { OperationNote } from "./notes-data";

export interface ExtractedTask {
  id: string;
  noteId: string;
  noteTitle: string;
  notebookId: string;
  notebookName: string;
  text: string;
  completed: boolean;
  line: number;
}

const TASK_RE = /^(\s*[-*+]\s+)\[( |x|X)\]\s+(.+)$/;

/** Extract all task items from a note's markdown content. */
export function extractTasksFromNote(
  note: OperationNote,
  notebookName: string,
): ExtractedTask[] {
  const lines = note.contentMarkdown.split("\n");
  const tasks: ExtractedTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    tasks.push({
      id: `${note.id}:${i}`,
      noteId: note.id,
      noteTitle: note.title || "未命名笔记",
      notebookId: note.notebookId,
      notebookName,
      text: m[3].trim(),
      completed: m[2].toLowerCase() === "x",
      line: i,
    });
  }
  return tasks;
}

/** Extract tasks from all notes. */
export function extractAllTasks(
  notes: OperationNote[],
  notebookNameById: Map<string, string>,
): ExtractedTask[] {
  const all: ExtractedTask[] = [];
  for (const note of notes) {
    const nbName = notebookNameById.get(note.notebookId) ?? "";
    all.push(...extractTasksFromNote(note, nbName));
  }
  return all;
}

/** Toggle a task's completion state in the given markdown string. */
export function toggleTaskInMarkdown(
  markdown: string,
  _noteId: string,
  line: number,
): string {
  const lines = markdown.split("\n");
  if (line < 0 || line >= lines.length) return markdown;
  const m = lines[line].match(TASK_RE);
  if (!m) return markdown;
  const isDone = m[2].toLowerCase() === "x";
  lines[line] = `${m[1]}[${isDone ? " " : "x"}] ${m[3]}`;
  return lines.join("\n");
}
