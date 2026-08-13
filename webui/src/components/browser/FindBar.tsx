import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/lib/tauri";
import { browserEvalScript, browserEvalScriptResult } from "@/lib/browser-ipc";

interface FindBarProps {
  tabId: string;
  visible: boolean;
  onClose: () => void;
}

// 注入到 WebView 中的查找脚本
const FIND_SCRIPT = `
(function() {
  // 清除之前的查找高亮
  function clearFind() {
    var marks = document.querySelectorAll('mark[data-mona-find]');
    marks.forEach(function(mark) {
      var parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  window.__monaClearFind = clearFind;

  window.__monaFindInPage = function(query) {
    clearFind();
    if (!query) return { count: 0, current: 0, matches: [] };

    var matches = [];
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          var parent = node.parentNode;
          if (!parent) return NodeFilter.FILTER_REJECT;
          var tag = parent.nodeName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'mark') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    var lowerQuery = query.toLowerCase();
    nodes.forEach(function(node) {
      var text = node.nodeValue;
      var lowerText = text.toLowerCase();
      var idx = 0;
      var parts = [];
      var lastEnd = 0;
      while ((idx = lowerText.indexOf(lowerQuery, lastEnd)) !== -1) {
        if (idx > lastEnd) parts.push({ text: text.slice(lastEnd, idx), match: false });
        parts.push({ text: text.slice(idx, idx + query.length), match: true });
        lastEnd = idx + query.length;
      }
      if (lastEnd < text.length) parts.push({ text: text.slice(lastEnd), match: false });

      if (parts.some(function(p) { return p.match; })) {
        var parent = node.parentNode;
        var frag = document.createDocumentFragment();
        parts.forEach(function(part) {
          if (part.match) {
            var mark = document.createElement('mark');
            mark.setAttribute('data-mona-find', '');
            mark.style.background = 'yellow';
            mark.style.color = 'black';
            mark.textContent = part.text;
            frag.appendChild(mark);
            matches.push(mark);
          } else {
            frag.appendChild(document.createTextNode(part.text));
          }
        });
        parent.replaceChild(frag, node);
      }
    });

    return { count: matches.length, current: 0, matches: matches };
  };

  window.__monaFindNavigate = function(direction, matches) {
    if (!matches || matches.length === 0) return 0;
    var current = document.querySelector('mark[data-mona-find-current]');
    var currentIdx = -1;
    if (current) {
      for (var i = 0; i < matches.length; i++) {
        if (matches[i] === current) { currentIdx = i; break; }
      }
    }
    if (direction === 'next') {
      currentIdx = (currentIdx + 1) % matches.length;
    } else {
      currentIdx = (currentIdx - 1 + matches.length) % matches.length;
    }
    if (current) {
      current.removeAttribute('data-mona-find-current');
      current.style.background = 'yellow';
    }
    var target = matches[currentIdx];
    target.setAttribute('data-mona-find-current', '');
    target.style.background = 'orange';
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return currentIdx;
  };
})();
`;

export function FindBar({ tabId, visible, onClose }: FindBarProps) {
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scriptInjectedRef = useRef(false);

  // 注入查找脚本
  useEffect(() => {
    if (!isTauri() || !visible) return;
    const inject = async () => {
      try {
        if (!scriptInjectedRef.current) {
          await browserEvalScript(tabId, FIND_SCRIPT);
          scriptInjectedRef.current = true;
        }
      } catch (e) {
        console.debug("[FindBar] inject script failed:", e);
      }
    };
    void inject();
  }, [tabId, visible]);

  useEffect(() => {
    scriptInjectedRef.current = false;
  }, [tabId]);

  // 聚焦输入框
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      // 关闭时清除高亮
      if (isTauri()) {
        browserEvalScript(tabId, "if (window.__monaClearFind) window.__monaClearFind();").catch(() => {});
      }
    }
  }, [visible, tabId]);

  // 查找
  const doFind = useCallback(async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    try {
      // 执行查找并通过 Tauri event 回传结果
      const result = await browserEvalScriptResult<{ count: number; current: number }>(
        tabId,
        `JSON.stringify((function() { window.__monaFindResult = window.__monaFindInPage(${JSON.stringify(q)}); return { count: window.__monaFindResult.count, current: window.__monaFindResult.current }; })())`
      );
      setMatchCount(result.count);
      setCurrentMatch(result.current);
    } catch (e) {
      console.debug("[FindBar] find failed:", e);
    }
  }, [tabId]);

  // 监听查找结果
  // 导航到下一个/上一个
  const navigate = useCallback(async (direction: "next" | "prev") => {
    if (!isTauri() || matchCount === 0) return;
    try {
      const result = await browserEvalScriptResult<{ current: number }>(
        tabId,
        `JSON.stringify((function() { var idx = window.__monaFindResult && window.__monaFindNavigate ? window.__monaFindNavigate(${JSON.stringify(direction)}, window.__monaFindResult.matches) : 0; return { current: idx }; })())`
      );
      setCurrentMatch(result.current);
    } catch (e) {
      console.debug("[FindBar] navigate failed:", e);
    }
  }, [tabId, matchCount]);

  // 监听导航结果
  // 键盘快捷键
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void navigate(e.shiftKey ? "prev" : "next");
    }
  };

  if (!visible) return null;

  return (
    <div className="absolute right-4 top-2 z-50 flex items-center gap-1.5 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
      <Search className="h-3.5 w-3.5 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => void doFind(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-6 w-48 rounded-full border-0 bg-muted/50 text-caption px-2"
        placeholder="查找..."
      />
      <span className="text-micro text-muted-foreground tabular-nums min-w-[60px] text-center">
        {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "0/0"}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        title="上一个 (Shift+Enter)"
        onClick={() => void navigate("prev")}
        disabled={matchCount === 0}
      >
        <ChevronUp className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        title="下一个 (Enter)"
        onClick={() => void navigate("next")}
        disabled={matchCount === 0}
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        title="关闭 (Esc)"
        onClick={onClose}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
