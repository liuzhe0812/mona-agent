import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useDbStore } from "./store/dbStore";

export function PropertiesPanel() {
  const selectedTable = useDbStore((s) => s.selectedTable);

  if (!selectedTable) {
    return (
      <div className="flex h-full flex-col border-l border-sidebar-border bg-sidebar">
        <div className="border-b border-sidebar-border px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          属性
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          选择一个表查看属性
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-sidebar-border bg-sidebar">
      <div className="border-b border-sidebar-border px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        表属性 · {selectedTable.name}
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3.5">
          <PropSection title="基本信息">
            {selectedTable.engine && <PropRow label="引擎" value={selectedTable.engine} />}
            {selectedTable.charset && <PropRow label="字符集" value={selectedTable.charset} />}
            {selectedTable.collation && <PropRow label="排序规则" value={selectedTable.collation} />}
            {selectedTable.row_count !== null && <PropRow label="行数" value={selectedTable.row_count.toLocaleString()} />}
            {selectedTable.data_size && <PropRow label="数据大小" value={selectedTable.data_size} />}
            {selectedTable.index_size && <PropRow label="索引大小" value={selectedTable.index_size} />}
            {selectedTable.auto_increment !== null && <PropRow label="自增值" value={selectedTable.auto_increment.toLocaleString()} />}
            {selectedTable.create_time && <PropRow label="创建时间" value={selectedTable.create_time} />}
            {selectedTable.update_time && <PropRow label="更新时间" value={selectedTable.update_time} />}
          </PropSection>

          <Separator className="my-3" />

          <PropSection title="列定义">
            {selectedTable.columns.map((col) => (
              <div key={col.name} className="mb-2">
                <div className="text-[12px] text-foreground">
                  {col.name} · <span className="text-muted-foreground">{col.data_type}</span>
                  {!col.nullable && <span className="text-muted-foreground"> · NOT NULL</span>}
                  {col.is_auto_increment && <span className="text-muted-foreground"> · AUTO_INCREMENT</span>}
                  {col.default_value && (
                    <span className="text-muted-foreground"> · DEFAULT {col.default_value}</span>
                  )}
                </div>
                {col.is_primary_key && (
                  <span className="text-[10px] text-yellow-500">⬥ PRIMARY KEY</span>
                )}
                {col.is_unique && !col.is_primary_key && (
                  <span className="text-[10px] text-blue-400">⬥ UNIQUE</span>
                )}
              </div>
            ))}
          </PropSection>

          <Separator className="my-3" />

          <PropSection title="索引">
            {selectedTable.indexes.length > 0 ? (
              selectedTable.indexes.map((idx) => (
                <PropRow
                  key={idx.name}
                  label={idx.name}
                  value={`${idx.columns.join(", ")}${idx.is_unique ? " (UNIQUE)" : ""}${idx.is_primary ? " (PRIMARY)" : ""}`}
                />
              ))
            ) : (
              <span className="text-xs italic text-muted-foreground">无索引</span>
            )}
          </PropSection>

          <Separator className="my-3" />

          <PropSection title="外键">
            {selectedTable.foreign_keys.length > 0 ? (
              selectedTable.foreign_keys.map((fk) => (
                <PropRow
                  key={fk.name}
                  label={fk.name}
                  value={`${fk.columns.join(", ")} → ${fk.ref_table}(${fk.ref_columns.join(", ")})`}
                />
              ))
            ) : (
              <span className="text-xs italic text-muted-foreground">无外键约束</span>
            )}
          </PropSection>

          {selectedTable.ddl && (
            <>
              <Separator className="my-3" />
              <PropSection title="DDL">
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {selectedTable.ddl}
                </pre>
              </PropSection>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function PropSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
