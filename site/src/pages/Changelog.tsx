import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Calendar, GitCommit, Tag, Sparkles } from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

interface Release {
  version: string;
  pubDate: string;
  gitHash: string;
  previousGitHash: string;
  summary: string;
  items: string[];
}

interface ChangelogData {
  releases: Release[];
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function Changelog() {
  const [data, setData] = useState<ChangelogData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/changelog.json")
      .then((res) => res.json())
      .then((json: ChangelogData) => {
        setData(json);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[#f7f7f5] text-[#101010]">
      <Navbar />

      <main className="mx-auto max-w-4xl px-6 pb-24 pt-32">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
        >
          <a
            href="/"
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-black/[0.55] transition-colors hover:text-black"
          >
            <ArrowLeft className="h-4 w-4" />
            返回首页
          </a>

          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-black/[0.55]">
            <Sparkles className="h-4 w-4" />
            Release Notes
          </div>
          <h1 className="mb-4 text-4xl font-semibold tracking-tight md:text-5xl">
            更新日志
          </h1>
          <p className="max-w-2xl text-base leading-7 text-black/[0.66] md:text-lg">
            追踪 Mona 每个版本的改进、修复与新能力。
          </p>
        </motion.div>

        <div className="mt-14 space-y-10">
          {loading && (
            <div className="animate-pulse space-y-4">
              <div className="h-6 w-32 rounded bg-black/10" />
              <div className="h-24 rounded-xl bg-black/10" />
            </div>
          )}

          {data?.releases.map((release, index) => (
            <motion.article
              key={release.version}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.55,
                delay: index * 0.08,
                ease: "easeOut",
              }}
              className="relative rounded-xl border border-black/10 bg-white/[0.6] p-6 backdrop-blur-sm md:p-8"
            >
              <div className="mb-5 flex flex-wrap items-center gap-4 border-b border-black/10 pb-5">
                <div className="flex items-center gap-2">
                  <Tag className="h-4 w-4 text-black/[0.55]" />
                  <span className="font-mono text-lg font-semibold">
                    v{release.version}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-black/[0.55]">
                  <Calendar className="h-4 w-4" />
                  {formatDate(release.pubDate)}
                </div>
                {release.gitHash && (
                  <div className="flex items-center gap-2 text-sm text-black/[0.55]">
                    <GitCommit className="h-4 w-4" />
                    <code className="font-mono text-xs">
                      {release.gitHash.slice(0, 8)}
                    </code>
                  </div>
                )}
              </div>

              <p className="mb-5 text-base leading-7 text-black/[0.74]">
                {release.summary}
              </p>

              <ul className="space-y-2.5">
                {release.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-3 text-sm leading-6 text-black/[0.66]"
                  >
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#101010]" />
                    {item}
                  </li>
                ))}
              </ul>
            </motion.article>
          ))}

          {!loading && data?.releases.length === 0 && (
            <div className="rounded-xl border border-black/10 bg-white/[0.6] p-8 text-center text-black/[0.55]">
              暂无发布记录。
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
