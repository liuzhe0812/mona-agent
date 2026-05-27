import type { ReactNode } from "react";
import { BookOpen, Database, FileText, Pencil, Plus, Tag, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { KnowledgeCategory, KnowledgeItem, OperationNote } from "./notes-data";

interface KnowledgeViewProps {
  categories: KnowledgeCategory[];
  items: KnowledgeItem[];
  activeCategoryId: string;
  notes: OperationNote[];
  onSelectCategory: (categoryId: string) => void;
  onOpenSourceNote: (noteId: string) => void;
  onMoveItem: (itemId: string, categoryId: string) => void;
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
  onMoveItem,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
}: KnowledgeViewProps) {
  const activeCategory =
    categories.find((category) => category.id === activeCategoryId) ?? categories[0] ?? null;
  const flattenedCategories = flattenCategories(categories);
  const activeCategoryIds = activeCategory
    ? collectCategoryIds(activeCategory.id, categories)
    : new Set<string>();
  const activeItems = activeCategory
    ? items.filter((item) => activeCategoryIds.has(item.categoryId))
    : [];

  return (
    <div className="flex min-h-0 flex-1 bg-background">
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
                  onClick={() => onSelectCategory(category.id)}
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

      <section className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[880px] px-5 py-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-[20px] font-semibold text-foreground">
                {activeCategory?.name ?? "知识库"}
              </h2>
              <p className="mt-1 text-[12px] text-muted-foreground">
                这里保存 AI 从笔记中提炼出的结构化知识点，原始内容仍保留在关联笔记里。
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2 py-1 text-[11px] text-muted-foreground">
              {activeItems.length} 条知识
            </span>
          </div>

          {activeItems.length === 0 ? (
            <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-dashed border-border/80 bg-muted/20 px-6 text-center text-[13px] text-muted-foreground">
              当前分类还没有知识点。回到笔记视图，点击右侧 Agent 的“提取知识点”生成。
            </div>
          ) : (
            <div className="space-y-3">
              {activeItems.map((item) => (
                <KnowledgeCard
                  key={item.id}
                  item={item}
                  categories={flattenedCategories}
                  sourceNote={notes.find((note) => note.id === item.sourceNoteId) ?? null}
                  onMoveItem={onMoveItem}
                  onOpenSourceNote={onOpenSourceNote}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function KnowledgeCard({
  item,
  categories,
  sourceNote,
  onMoveItem,
  onOpenSourceNote,
}: {
  item: KnowledgeItem;
  categories: FlattenedCategory[];
  sourceNote: OperationNote | null;
  onMoveItem: (itemId: string, categoryId: string) => void;
  onOpenSourceNote: (noteId: string) => void;
}) {
  return (
    <article className="rounded-lg border border-border/70 bg-background px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.035)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-foreground">{item.title}</h3>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{item.summary}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] text-muted-foreground">{item.updatedAt}</span>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            分类
            <select
              value={item.categoryId}
              onChange={(event) => onMoveItem(item.id, event.target.value)}
              className="h-7 max-w-[140px] rounded-md border border-border/70 bg-background px-2 text-[11px] outline-none hover:bg-accent focus:border-[#6aa7ff]/70"
            >
              {categories.map(({ category, depth }) => (
                <option key={category.id} value={category.id}>
                  {`${"\u00a0".repeat(depth * 2)}${category.name}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="mt-3 whitespace-pre-wrap rounded-lg border border-border/65 bg-muted/25 px-3 py-2.5 text-[12.5px] leading-6 text-foreground/86">
        {item.content}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {item.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border border-border/65 bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <Tag className="h-3 w-3" />
            {tag}
          </span>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[11.5px] text-muted-foreground">
        <span className="min-w-0 truncate">
          来源：{item.sourceDescription || "来自当前笔记"}
        </span>
        <button
          type="button"
          disabled={!sourceNote}
          onClick={() => onOpenSourceNote(item.sourceNoteId)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <FileText className="h-3.5 w-3.5" />
          {sourceNote ? `打开原始笔记：${item.sourceNoteTitle}` : "原始笔记不存在"}
        </button>
      </div>
    </article>
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
