import { Copy } from "lucide-react";

interface TerminalBlockProps {
  lines: string[];
}

export default function TerminalBlock({ lines }: TerminalBlockProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/10 bg-white font-mono text-sm text-[#101010]">
      <div className="flex items-center gap-2 border-b border-black/10 bg-[#f7f7f5] px-4 py-3">
        <div className="h-3 w-3 rounded-full bg-[#101010]" />
        <div className="h-3 w-3 rounded-full bg-black/35" />
        <div className="h-3 w-3 rounded-full bg-black/14" />
        <span className="ml-auto text-xs text-black/40">bash</span>
        <button
          type="button"
          className="text-black/40 transition-colors hover:text-black"
          aria-label="Copy command"
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2 p-4">
        {lines.map((line) => (
          <div key={line} className="flex">
            <span className="mr-2 select-none text-black">$</span>
            <span className="text-black/80">{line}</span>
          </div>
        ))}
        <div className="flex">
          <span className="mr-2 select-none text-black">$</span>
          <span className="animate-cursor-blink text-black">▊</span>
        </div>
      </div>
    </div>
  );
}
