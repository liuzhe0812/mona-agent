import type { Metadata } from "next";
import Link from "next/link";
import changelog from "../../public/changelog.json";

export const metadata: Metadata = {
  title: "更新日志 — Mona",
  description: "查看 Mona 的版本更新、修复与新增能力。",
};

const [latest, ...releases] = changelog.releases;
const displayDate = (date: string) => date.slice(0, 10).replaceAll("-", ".");

export default function Changelog() {
  return (
    <main className="editorial-page changelog-page">
      <header className="editorial-topbar">
        <Link className="editorial-brand" href="/">
          <img src="/img/mona-logo.png" alt="" />
          <span>MONA</span>
        </Link>
        <nav aria-label="页面导航">
          <Link href="/">首页</Link>
          <a href="/manual.html">快速入门</a>
          <Link href="/tutorial">免费模型</Link>
          <Link aria-current="page" href="/changelog">
            更新日志
          </Link>
        </nav>
        <a className="editorial-download" href="/manual.html">
          开始使用 ↗
        </a>
      </header>

      <section className="editorial-hero changelog-hero">
        <div className="editorial-kicker">SYSTEM LOG / LIVE</div>
        <p className="editorial-side-note">
          {changelog.releases.length} RELEASES / STILL MOVING
        </p>
        <h1>
          每次更新，
          <br />
          都让 Mona
          <br />
          <em>更能做事。</em>
        </h1>
        <p className="editorial-lead">
          新能力、关键修复和工作流变化，都在这里留下可追溯的记录。
        </p>
      </section>

      <section className="release-section" aria-labelledby="release-heading">
        <header className="editorial-section-heading">
          <span>LATEST RELEASE / {displayDate(latest.pubDate)}</span>
          <h2 id="release-heading">v{latest.version}</h2>
        </header>

        <article className="latest-release">
          <div className="release-meta">
            <strong>NOW</strong>
            <span>{displayDate(latest.pubDate)}</span>
            <code>{latest.gitHash.slice(0, 8)}</code>
          </div>
          <ul>
            {latest.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <div className="release-list">
          {releases.map((release, index) => (
            <article key={release.version}>
              <header>
                <span>{String(index + 2).padStart(2, "0")}</span>
                <div>
                  <h3>v{release.version}</h3>
                  <p>{displayDate(release.pubDate)}</p>
                </div>
                <code>{release.gitHash.slice(0, 8)}</code>
              </header>
              <ul>
                {release.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <footer className="editorial-footer">
        <span>NEXT MISSION</span>
        <h2>现在就试试最新版本。</h2>
        <a href="/manual.html">进入快速入门 →</a>
      </footer>
    </main>
  );
}
