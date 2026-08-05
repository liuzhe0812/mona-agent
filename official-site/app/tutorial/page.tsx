import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "免费模型接入指南 — Mona",
  description: "获取免费 API 密钥，并在 Mona 中配置对话、图像和视频模型。",
};

const DOWNLOAD_URL = "https://dl.mona.lzfun.vip/Mona-latest.exe";

const modelSteps = [
  {
    number: "01",
    title: "进入 Agnes AI",
    copy: "访问官网并进入模型平台。",
    image: "/img/tutorial/01-homepage.png",
  },
  {
    number: "02",
    title: "注册或登录",
    copy: "完成账户登录，进入控制台。",
    image: "/img/tutorial/02-login.png",
  },
  {
    number: "03",
    title: "创建 API 密钥",
    copy: "新建密钥并复制，稍后填入 Mona。",
    image: "/img/tutorial/03-api-keys.png",
  },
] as const;

export default function Tutorial() {
  return (
    <main className="editorial-page">
      <header className="editorial-topbar">
        <Link className="editorial-brand" href="/">
          <img src="/img/mona-logo.png" alt="" />
          <span>MONA</span>
        </Link>
        <nav aria-label="页面导航">
          <Link href="/">首页</Link>
          <a href="/manual.html">快速入门</a>
          <Link aria-current="page" href="/tutorial">
            免费模型
          </Link>
          <Link href="/changelog">更新日志</Link>
        </nav>
        <a className="editorial-download" href={DOWNLOAD_URL}>
          下载 Mona ↗
        </a>
      </header>

      <section className="editorial-hero tutorial-hero">
        <div className="editorial-kicker">FREE MODEL / 001</div>
        <p className="editorial-side-note">LLM / IMAGE / VIDEO</p>
        <h1>
          三步，
          <br />
          获取
          <br />
          <em>免费模型。</em>
        </h1>
        <p className="editorial-lead">
          获取 Agnes AI 的 API 密钥，再粘贴到 Mona 设置中，连接对话、图像和视频模型。
        </p>
        <a
          className="editorial-primary"
          href="https://platform.agnes-ai.com/"
          target="_blank"
          rel="noreferrer"
        >
          获取 API 密钥 <span>→</span>
        </a>
      </section>

      <section
        id="free-model"
        className="free-model-section"
        aria-labelledby="free-model-heading"
      >
        <header className="editorial-section-heading">
          <span>FREE MODEL / OPTIONAL ROUTE</span>
          <h2 id="free-model-heading">还没有模型？</h2>
          <p>现有指南使用 Agnes AI 作为免费模型入口。</p>
        </header>

        <div className="model-step-grid">
          {modelSteps.map((step) => (
            <article key={step.number}>
              <div className="model-step-image">
                <img src={step.image} alt={`${step.title}界面`} />
              </div>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </article>
          ))}
        </div>

        <div className="model-config">
          <div>
            <span>在 Mona 中</span>
            <h3>填入模型配置</h3>
            <p>
              打开“设置 → 模型设置”，新建 OpenAI 兼容供应商，填入刚创建的
              API 密钥。
            </p>
            <a
              href="https://platform.agnes-ai.com/"
              target="_blank"
              rel="noreferrer"
            >
              前往 Agnes AI 平台 ↗
            </a>
          </div>
          <dl>
            <div>
              <dt>BASE URL</dt>
              <dd>
                <code>https://apihub.agnes-ai.com/v1</code>
              </dd>
            </div>
            <div>
              <dt>对话模型</dt>
              <dd>
                <code>agnes-2.0-flash</code>
              </dd>
            </div>
            <div>
              <dt>图像模型</dt>
              <dd>
                <code>agnes-image-2.1-flash</code>
              </dd>
            </div>
            <div>
              <dt>视频模型</dt>
              <dd>
                <code>agnes-video-v2.0</code>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <footer className="editorial-footer">
        <span>READY?</span>
        <h2>把免费模型接入 Mona。</h2>
        <a
          href="https://platform.agnes-ai.com/"
          target="_blank"
          rel="noreferrer"
        >
          获取 API 密钥 →
        </a>
      </footer>
    </main>
  );
}
