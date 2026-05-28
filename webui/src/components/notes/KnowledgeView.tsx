import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  Database,
  FileText,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type {
  KnowledgeCategory,
  KnowledgeItem,
  KnowledgeLinkedNote,
  OperationNote,
} from "./notes-data";

type KnowledgeScope = "category" | "all";
type KnowledgeSort = "recent" | "title";
type KnowledgeItemUpdate = Pick<
  KnowledgeItem,
  "title" | "summary" | "content" | "sourceDescription" | "tags"
>;

interface KnowledgeViewProps {
  categories: KnowledgeCategory[];
  items: KnowledgeItem[];
  activeCategoryId: string;
  notes: OperationNote[];
  onSelectCategory: (categoryId: string) => void;
  onOpenSourceNote: (noteId: string, knowledgeItemId: string) => void;
  onMoveItem: (itemId: string, categoryId: string) => void;
  onUpdateItem: (itemId: string, patch: KnowledgeItemUpdate) => void;
  onDeleteItem: (itemId: string) => void;
  onCreateCategory: (parentId?: string | null) => void;
  onRenameCategory: (categoryId: string) => void;
  onDeleteCategory: (categoryId: string) => void;
}

export function KnowledgeView({
  categories,
  items,
  activeCategoryId,
  notes,
  onSelectCategory,
  onOpenSourceNote,
  onMoveItem: _onMoveItem,
  onUpdateItem,
  onDeleteItem,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
}: KnowledgeViewProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<KnowledgeScope>("category");
  const [tagFilter, setTagFilter] = useState("");
  const [sortMode, setSortMode] = useState<KnowledgeSort>("recent");

  const flattenedCategories = useMemo(() => flattenCategories(categories), [categories]);
  const activeCategory =
    categories.find((category) => category.id === activeCategoryId) ?? categories[0] ?? null;
  const activeCategoryIds = useMemo(
    () => (activeCategory ? collectCategoryIds(activeCategory.id, categories) : new Set<string>()),
    [activeCategory, categories],
  );
  const categoryItems = useMemo(
    () => items.filter((item) => activeCategoryIds.has(item.categoryId)),
    [activeCategoryIds, items],
  );
  const scopedItems = scope === "all" ? items : categoryItems;
  const tagOptions = useMemo(() => collectTags(scopedItems), [scopedItems]);
  const visibleItems = useMemo(
    () => filterKnowledgeItems(scopedItems, query, tagFilter, sortMode, categories, notes),
    [categories, notes, query, scopedItems, sortMode, tagFilter],
  );

  useEffect(() => {
    if (tagFilter && !tagOptions.includes(tagFilter)) {
      setTagFilter("");
    }
  }, [tagFilter, tagOptions]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <aside className="hidden w-[224px] shrink-0 border-r border-border/70 bg-sidebar/35 md:flex md:flex-col">
        <div className="border-b border-border/65 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-foreground/88">
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              知识分类
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <CategoryActionButton label="新建一级分类" onClick={() => onCreateCategory(null)}>
                <Plus className="h-3.5 w-3.5" />
              </CategoryActionButton>
              <CategoryActionButton
                label="重命名分类"
                disabled={!activeCategory}
                onClick={() => activeCategory && onRenameCategory(activeCategory.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </CategoryActionButton>
              <CategoryActionButton
                label="删除分类"
                disabled={!activeCategory || categories.length <= 1}
                onClick={() => activeCategory && onDeleteCategory(activeCategory.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </CategoryActionButton>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
          {flattenedCategories.map(({ category, depth }) => {
            const count = countCategoryItems(category.id, categories, items);
            return (
              <div
                key={category.id}
                className={cn(
                  "mb-1 flex w-full items-center gap-1 rounded-lg border transition-colors",
                  category.id === activeCategory?.id
                    ? "border-[#6aa7ff]/40 bg-[#6aa7ff]/8"
                    : "border-transparent hover:border-border/70 hover:bg-background",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectCategory(category.id);
                    setScope("category");
                  }}
                  style={{ paddingLeft: `${10 + depth * 14}px` }}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 text-left"
                >
                  <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-foreground/88">
                      {category.name}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`在 ${category.name} 下新建子分类`}
                  title="新建子分类"
                  onClick={() => onCreateCategory(category.id)}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <span className="shrink-0 pr-2 text-[11px] text-muted-foreground">{count}</span>
              </div>
            );
          })}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        <div className="mx-auto w-full min-w-0 max-w-[920px] px-5 py-5">
          <KnowledgeDirectory
            title={scope === "all" ? "全部知识" : activeCategory?.name ?? "知识库"}
            items={visibleItems}
            totalCount={scopedItems.length}
            categories={categories}
            notes={notes}
            query={query}
            scope={scope}
            tagFilter={tagFilter}
            tagOptions={tagOptions}
            sortMode={sortMode}
            onQueryChange={setQuery}
            onScopeChange={setScope}
            onTagFilterChange={setTagFilter}
            onSortModeChange={setSortMode}
            onOpenSourceNote={onOpenSourceNote}
            onUpdateItem={onUpdateItem}
            onDeleteItem={onDeleteItem}
          />
        </div>
      </section>
    </div>
  );
}

function KnowledgeDirectory({
  title,
  items,
  totalCount,
  categories,
  notes,
  query,
  scope,
  tagFilter,
  tagOptions,
  sortMode,
  onQueryChange,
  onScopeChange,
  onTagFilterChange,
  onSortModeChange,
  onOpenSourceNote,
  onUpdateItem,
  onDeleteItem,
}: {
  title: string;
  items: KnowledgeItem[];
  totalCount: number;
  categories: KnowledgeCategory[];
  notes: OperationNote[];
  query: string;
  scope: KnowledgeScope;
  tagFilter: string;
  tagOptions: string[];
  sortMode: KnowledgeSort;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: KnowledgeScope) => void;
  onTagFilterChange: (tag: string) => void;
  onSortModeChange: (sortMode: KnowledgeSort) => void;
  onOpenSourceNote: (noteId: string, knowledgeItemId: string) => void;
  onUpdateItem: (itemId: string, patch: KnowledgeItemUpdate) => void;
  onDeleteItem: (itemId: string) => void;
}) {
  const hasFilter = Boolean(query.trim() || tagFilter);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[20px] font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            用搜索和筛选定位知识点，卡片内保留精简总结并打开关联笔记。
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2 py-1 text-[11px] text-muted-foreground">
          {items.length}/{totalCount} 条
        </span>
      </div>

      <div className="mb-3 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-md border border-border/70 bg-background px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索标题、精简总结、标签、来源..."
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <button
                type="button"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => onQueryChange("")}
                className="grid h-5 w-5 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <div className="flex h-8 items-center rounded-md border border-border/70 bg-muted/25 p-0.5">
            <FilterButton active={scope === "category"} onClick={() => onScopeChange("category")}>
              当前分类
            </FilterButton>
            <FilterButton active={scope === "all"} onClick={() => onScopeChange("all")}>
              全部知识
            </FilterButton>
          </div>

          <select
            value={tagFilter}
            onChange={(event) => onTagFilterChange(event.target.value)}
            className="h-8 max-w-full rounded-md border border-border/70 bg-background px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent focus:border-[#6aa7ff]/70"
          >
            <option value="">全部标签</option>
            {tagOptions.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>

          <select
            value={sortMode}
            onChange={(event) => onSortModeChange(event.target.value as KnowledgeSort)}
            className="h-8 max-w-full rounded-md border border-border/70 bg-background px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent focus:border-[#6aa7ff]/70"
          >
            <option value="recent">最近更新</option>
            <option value="title">标题排序</option>
          </select>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-border/80 bg-muted/20 px-6 text-center text-[13px] text-muted-foreground">
          {hasFilter
            ? "没有匹配的知识点。可以调整搜索词、标签或搜索范围。"
            : "当前范围还没有知识点。回到笔记视图，点击右侧 Agent 的“提取知识点”生成。"}
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => (
            <KnowledgeCard
              key={item.id}
              item={item}
              categoryPath={getCategoryPath(item.categoryId, categories)}
              notes={notes}
              onOpenSourceNote={onOpenSourceNote}
              onUpdateItem={onUpdateItem}
              onDeleteItem={onDeleteItem}
            />
          ))}
        </div>
      )}
    </>
  );
}

function KnowledgeCard({
  item,
  categoryPath,
  notes,
  onOpenSourceNote,
  onUpdateItem,
  onDeleteItem,
}: {
  item: KnowledgeItem;
  categoryPath: string;
  notes: OperationNote[];
  onOpenSourceNote: (noteId: string, knowledgeItemId: string) => void;
  onUpdateItem: (itemId: string, patch: KnowledgeItemUpdate) => void;
  onDeleteItem: (itemId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => createKnowledgeEditDraft(item));
  const [editError, setEditError] = useState("");
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const linkedNotes = getKnowledgeLinkedNotes(item);

  useEffect(() => {
    setEditing(false);
    setEditError("");
    setDraft(createKnowledgeEditDraft(item));
  }, [item.id]);

  const saveEdit = () => {
    const nextTitle = draft.title.trim();
    const nextSummary = draft.summary.trim();
    const nextTags = parseTagsText(draft.tagsText);
    if (!nextTitle || !nextSummary) {
      setEditError("标题、精简总结不能为空");
      return;
    }
    if (nextTags.length < 1 || nextTags.length > 4) {
      setEditError("标签需要 1-4 个");
      return;
    }

    onUpdateItem(item.id, {
      title: nextTitle,
      summary: nextSummary,
      content: nextSummary,
      sourceDescription: draft.sourceDescription.trim(),
      tags: nextTags,
    });
    setEditError("");
    setEditing(false);
  };

  return (
    <article className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.025)]">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <input
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
                className="w-full rounded-md border border-border/70 bg-background px-2.5 py-2 text-[15px] font-semibold outline-none focus:border-[#6aa7ff]/70"
                placeholder="知识点标题"
              />
              <textarea
                value={draft.summary}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, summary: event.target.value }))
                }
                className="min-h-[58px] w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-2 text-[12.5px] leading-5 outline-none focus:border-[#6aa7ff]/70"
                placeholder="精简内容总结"
              />
            </div>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <h3 className="min-w-0 break-words text-[15px] font-semibold leading-6 text-foreground">
                  {item.title}
                </h3>
                <span className="rounded-full border border-border/65 bg-muted/25 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                  {categoryPath}
                </span>
              </div>
              <p className="mt-1.5 break-words text-[12.5px] leading-5 text-muted-foreground">
                {item.summary}
              </p>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{item.updatedAt}</span>
          {editing ? (
            <>
              <IconActionButton label="保存修改" onClick={saveEdit}>
                <Check className="h-3.5 w-3.5" />
              </IconActionButton>
              <IconActionButton
                label="取消编辑"
                onClick={() => {
                  setDraft(createKnowledgeEditDraft(item));
                  setEditError("");
                  setEditing(false);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </IconActionButton>
            </>
          ) : (
            <>
              <IconActionButton label="编辑知识点" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </IconActionButton>
              <IconActionButton label="删除知识点" onClick={() => onDeleteItem(item.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconActionButton>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <label className="block text-[11.5px] text-muted-foreground">
              标签
              <input
                value={draft.tagsText}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, tagsText: event.target.value }))
                }
                className="mt-1 h-8 w-full rounded-md border border-border/70 bg-background px-2.5 text-[12px] text-foreground outline-none focus:border-[#6aa7ff]/70"
                placeholder="用逗号或空格分隔，1-4 个"
              />
            </label>
            <label className="block text-[11.5px] text-muted-foreground">
              来源说明
              <input
                value={draft.sourceDescription}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    sourceDescription: event.target.value,
                  }))
                }
                className="mt-1 h-8 w-full rounded-md border border-border/70 bg-background px-2.5 text-[12px] text-foreground outline-none focus:border-[#6aa7ff]/70"
                placeholder="来源链接或来源说明"
              />
            </label>
          </div>
          {editError ? <div className="mt-2 text-[11.5px] text-destructive">{editError}</div> : null}
        </>
      ) : (
        <>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
            {item.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/65 bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                <Tag className="h-3 w-3 shrink-0" />
                <span className="truncate">{tag}</span>
              </span>
            ))}
            {item.tags.length > 4 ? (
              <span className="rounded-full border border-border/65 bg-muted/25 px-2 py-0.5 text-[11px] text-muted-foreground">
                +{item.tags.length - 4}
              </span>
            ) : null}
          </div>
        </>
      )}

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
        <span className="text-[11px] text-muted-foreground">
          关联 {linkedNotes.length} 篇笔记：
        </span>
        {linkedNotes.map((linkedNote) => {
          const sourceNote = noteById.get(linkedNote.noteId) ?? null;
          const noteTitle = sourceNote?.title ?? linkedNote.noteTitle;
          return (
            <button
              key={linkedNote.noteId}
              type="button"
              disabled={!sourceNote}
              onClick={() => onOpenSourceNote(linkedNote.noteId, item.id)}
              title={linkedNote.description || "关联笔记"}
              className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{noteTitle}</span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 rounded px-2 text-[11.5px] font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function IconActionButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-md border border-border/70 bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function createKnowledgeEditDraft(item: KnowledgeItem) {
  return {
    title: item.title,
    summary: item.summary,
    content: item.content,
    sourceDescription: item.sourceDescription,
    tagsText: item.tags.join(", "),
  };
}

function parseTagsText(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,，、]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

interface FlattenedCategory {
  category: KnowledgeCategory;
  depth: number;
}

function flattenCategories(categories: KnowledgeCategory[]): FlattenedCategory[] {
  const childrenByParent = new Map<string | null, KnowledgeCategory[]>();
  for (const category of categories) {
    const parentId =
      category.parentId && categories.some((item) => item.id === category.parentId)
        ? category.parentId
        : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(category);
    childrenByParent.set(parentId, siblings);
  }

  const result: FlattenedCategory[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const category of childrenByParent.get(parentId) ?? []) {
      if (visited.has(category.id)) continue;
      visited.add(category.id);
      result.push({ category, depth });
      visit(category.id, depth + 1);
    }
  };

  visit(null, 0);
  for (const category of categories) {
    if (!visited.has(category.id)) {
      result.push({ category, depth: 0 });
    }
  }

  return result;
}

function collectCategoryIds(categoryId: string, categories: KnowledgeCategory[]): Set<string> {
  const ids = new Set<string>([categoryId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) {
      if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        changed = true;
      }
    }
  }
  return ids;
}

function countCategoryItems(
  categoryId: string,
  categories: KnowledgeCategory[],
  items: KnowledgeItem[],
): number {
  const ids = collectCategoryIds(categoryId, categories);
  return items.filter((item) => ids.has(item.categoryId)).length;
}

function collectTags(items: KnowledgeItem[]): string[] {
  return Array.from(new Set(items.flatMap((item) => item.tags))).sort((a, b) =>
    a.localeCompare(b, "zh-Hans-CN"),
  );
}

function getKnowledgeLinkedNotes(item: KnowledgeItem): KnowledgeLinkedNote[] {
  const result: KnowledgeLinkedNote[] = [];
  const upsert = (linkedNote: KnowledgeLinkedNote) => {
    if (!linkedNote.noteId) return;
    const existingIndex = result.findIndex((entry) => entry.noteId === linkedNote.noteId);
    if (existingIndex >= 0) {
      result[existingIndex] = linkedNote;
      return;
    }
    result.push(linkedNote);
  };

  upsert({
    noteId: item.sourceNoteId,
    noteTitle: item.sourceNoteTitle || "未命名笔记",
    description: item.sourceDescription || "原始笔记",
    linkedAt: item.updatedAt,
  });
  for (const linkedNote of item.linkedNotes ?? []) {
    upsert(linkedNote);
  }

  return result;
}

function filterKnowledgeItems(
  items: KnowledgeItem[],
  query: string,
  tagFilter: string,
  sortMode: KnowledgeSort,
  categories: KnowledgeCategory[],
  notes: OperationNote[],
): KnowledgeItem[] {
  const keyword = query.trim().toLowerCase();
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const filtered = items.filter((item) => {
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (!keyword) return true;

    const linkedNotes = getKnowledgeLinkedNotes(item);
    const linkedNoteText = linkedNotes.flatMap((linkedNote) => [
      linkedNote.noteTitle,
      linkedNote.description,
      noteById.get(linkedNote.noteId)?.title,
    ]);
    const haystack = [
      item.title,
      item.summary,
      item.tags.join(" "),
      item.sourceDescription,
      item.sourceNoteTitle,
      ...linkedNoteText,
      getCategoryPath(item.categoryId, categories),
      item.content,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  });

  if (sortMode === "title") {
    return [...filtered].sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  }

  return filtered;
}

function getCategoryPath(categoryId: string, categories: KnowledgeCategory[]): string {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const category = byId.get(categoryId);
  if (!category) return "未分类";

  const names: string[] = [];
  let current: KnowledgeCategory | undefined = category;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return names.join(" / ") || "未分类";
}

function CategoryActionButton({
  label,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
