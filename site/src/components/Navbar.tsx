import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { DOWNLOAD_URL } from "@/lib/constants";

const links = [
  { label: "快速入门", href: "/manual.html" },
  { label: "Agent", href: "/#agent" },
  { label: "模块", href: "/#modules" },
  { label: "白盒运维", href: "/#whitebox" },
  { label: "桌面端", href: "/#desktop" },
  { label: "更新日志", href: "/changelog" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 36);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <nav
      className={`fixed left-0 right-0 top-0 z-[70] transition-all duration-300 ${
        scrolled
          ? "border-b border-black/10 bg-white/[0.86] backdrop-blur-xl"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <a href="/" className="font-mono text-lg font-semibold tracking-normal text-[#101010]">
          Mona
        </a>
        <div className="hidden items-center gap-7 md:flex">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="relative text-sm text-black/[0.55] transition-colors duration-300 hover:text-black"
            >
              {link.label}
            </a>
          ))}
        </div>
        <a
          href={DOWNLOAD_URL}
          className="inline-flex items-center gap-2 rounded-md border border-black bg-[#101010] px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
        >
          <Download className="h-4 w-4" />
          下载
        </a>
      </div>
    </nav>
  );
}
