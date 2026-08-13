import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { searchContacts } from "./lib/contactsApi";
import type { Contact } from "./lib/types";

interface ContactPickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * 收件人输入框 + 联系人自动补全。
 *
 * 输入 ≥2 字符时模糊搜索本地联系人，下拉显示匹配项。
 * 点击建议插入为 "显示名 <邮箱>" 格式（若已有内容则追加，逗号分隔）。
 */
export function ContactPicker({
  value,
  onChange,
  placeholder,
  className,
}: ContactPickerProps) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 输入变化时搜索（防抖 200ms）
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    // 取当前正在输入的最后一个 token（逗号后的部分）
    const tokens = value.split(/[,，]/);
    const lastToken = tokens[tokens.length - 1].trim();

    if (lastToken.length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await searchContacts(lastToken, 10);
        setSuggestions(results);
        setShowDropdown(results.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
        setShowDropdown(false);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const insertContact = (contact: Contact) => {
    const email = contact.email || "";
    if (!email) {
      setShowDropdown(false);
      return;
    }
    const formatted = contact.displayName
      ? `${contact.displayName} <${email}>`
      : email;

    // 替换当前正在输入的 token
    const tokens = value.split(/([,，])/);
    // 找到最后一个非分隔符的 token 并替换
    const newTokens = [...tokens];
    for (let i = newTokens.length - 1; i >= 0; i--) {
      if (!/^[,，]$/.test(newTokens[i])) {
        newTokens[i] = formatted;
        break;
      }
    }
    let newValue = newTokens.join("");
    // 若原值不以逗号结尾且非空，追加逗号空格
    if (newValue && !/[,，]\s*$/.test(newValue)) {
      newValue += ", ";
    }
    onChange(newValue);
    setShowDropdown(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      insertContact(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setShowDropdown(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setShowDropdown(true);
        }}
        placeholder={placeholder}
        className={cn(
          "h-7 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-ui shadow-none focus-visible:ring-0",
          className,
        )}
      />
      {loading && (
        <Loader2 className="absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
      {showDropdown && suggestions.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-[240px] w-full min-w-[280px] overflow-y-auto rounded-md border border-border bg-popover shadow-md">
          {suggestions.map((c, idx) => (
            <Button
              key={c.id}
              type="button"
              variant="ghost"
              onMouseDown={(e) => {
                e.preventDefault(); // 防止输入框失焦
                insertContact(c);
              }}
              onMouseEnter={() => setActiveIndex(idx)}
              className={cn(
                "h-auto w-full justify-start gap-2 rounded-none px-3 py-1.5 text-left text-caption font-normal",
                idx === activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent",
              )}
            >
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-info/10 text-micro font-medium text-info-strong">
                {c.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">
                  {c.displayName}
                </div>
                {c.email && (
                  <div className="truncate text-micro text-muted-foreground">
                    {c.email}
                  </div>
                )}
              </div>
              {c.organization && (
                <span className="shrink-0 text-micro text-muted-foreground">
                  {c.organization}
                </span>
              )}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
