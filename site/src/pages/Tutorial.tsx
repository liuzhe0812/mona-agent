import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Key,
  Image as ImageIcon,
  Video,
  MessageSquare,
  Settings,
} from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const AGNES_SITE = "https://agnes-ai.com/";
const AGNES_PLATFORM = "https://platform.agnes-ai.com/";

interface Step {
  num: string;
  title: string;
  desc: string;
  image: string;
  caption?: string;
}

const steps: Step[] = [
  {
    num: "01",
    title: "访问 Agnes AI 官网",
    desc: "打开 agnes-ai.com，首页展示 Agnes 全栈多模态 AI 模型矩阵——文本、图像与视频生成，标注「免费 API」。点击右上角「登录」进入开发者平台。",
    image: "/img/tutorial/01-homepage.png",
    caption: "Agnes AI 官网首页，点击右上角「登录」进入开发者平台",
  },
  {
    num: "02",
    title: "注册 / 登录账户",
    desc: "在开发者平台登录页，新用户点击「注册」创建账户，已有账户直接输入邮箱和密码登录。登录后自动跳转至控制台。",
    image: "/img/tutorial/02-login.png",
    caption: "Agnes AI 开发者平台登录页",
  },
  {
    num: "03",
    title: "创建并复制 API 密钥",
    desc: "登录后进入「API 密钥」页面，点击「创建新的密钥」即可生成一个以 sk- 开头的 API Key。点击密钥右侧的复制按钮将其复制到剪贴板——这把 Key 将用于 Mona 的全部 AI 功能。",
    image: "/img/tutorial/03-api-keys.png",
    caption: "API 密钥管理页面，点击「创建新的密钥」生成并复制 Key",
  },
];

const monaSteps = [
  {
    icon: Settings,
    title: "打开 Mona 设置",
    desc: "点击 Mona 标题栏右上角的齿轮图标（设置按钮），进入设置面板。",
  },
  {
    icon: MessageSquare,
    title: "配置 LLM 模型",
    desc: "在「模型」分类下找到 Agnes AI，点击展开。将第 3 步复制的 API Key 粘贴到密钥输入框（Base URL 已预填为 https://apihub.agnes-ai.com/v1），模型选择 agnes-2.0-flash，保存并设为默认。",
  },
  {
    icon: ImageIcon,
    title: "配置图像生成",
    desc: "切换到「图像生成」分类，选择 Provider 为 Agnes AI，填入同一把 API Key，模型选择 agnes-image-2.1-flash，保存。",
  },
  {
    icon: Video,
    title: "配置视频生成",
    desc: "切换到「视频生成」分类，选择 Provider 为 Agnes AI，填入同一把 API Key，模型默认为 agnes-video-v2.0，保存。",
  },
];

export default function Tutorial() {
  return (
    <div className="min-h-screen bg-[#f7f7f5] text-[#101010]">
      <Navbar />

      <main className="mx-auto max-w-4xl px-6 pb-24 pt-32">
        {/* Header */}
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
            <Key className="h-4 w-4" />
            免费模型接入指南
          </div>
          <h1 className="mb-4 text-4xl font-semibold tracking-tight md:text-5xl">
            获取免费 LLM / 图像 / 视频模型
          </h1>
          <p className="max-w-2xl text-base leading-7 text-black/[0.66] md:text-lg">
            Agnes AI 提供全栈多模态 AI 模型——文本推理、图像生成与视频生成，当前均可免费使用。
            只需 3 步获取 API Key，再粘贴到 Mona 设置即可激活全部 AI 能力。
          </p>

          {/* Quick links */}
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={AGNES_SITE}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-black bg-[#101010] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
            >
              <ExternalLink className="h-4 w-4" />
              前往 Agnes AI 官网
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href={AGNES_PLATFORM}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-black/10 bg-white/[0.7] px-5 py-2.5 text-sm font-medium transition hover:border-black/20 hover:bg-white"
            >
              <Key className="h-4 w-4" />
              开发者平台
            </a>
          </div>
        </motion.div>

        {/* Step-by-step: get API key */}
        <section className="mt-16">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">
            获取 API Key
          </h2>
          <p className="mb-8 max-w-2xl text-sm leading-7 text-black/[0.66]">
            按以下三步在 Agnes AI 平台获取免费的 API Key。
          </p>
          <div className="space-y-12">
            {steps.map((step, index) => (
              <motion.div
                key={step.num}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.55,
                  delay: index * 0.08,
                  ease: "easeOut",
                }}
                className="relative"
              >
                <div className="mb-4 flex items-start gap-4">
                  <span className="font-mono text-3xl font-bold text-black/[0.12]">
                    {step.num}
                  </span>
                  <div className="flex-1">
                    <h3 className="mb-2 text-xl font-semibold">
                      {step.title}
                    </h3>
                    <p className="text-sm leading-7 text-black/[0.66]">
                      {step.desc}
                    </p>
                  </div>
                </div>
                <figure className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
                  <a href={step.image} target="_blank" rel="noopener noreferrer">
                    <img
                      src={step.image}
                      alt={step.caption || step.title}
                      className="w-full cursor-zoom-in transition-opacity hover:opacity-95"
                      loading="lazy"
                    />
                  </a>
                  {step.caption && (
                    <figcaption className="border-t border-black/[0.06] px-5 py-3 text-xs leading-5 text-black/[0.48]">
                      {step.caption}
                    </figcaption>
                  )}
                </figure>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Configure in Mona */}
        <section className="mt-20">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">
            配置到 Mona
          </h2>
          <p className="mb-8 max-w-2xl text-sm leading-7 text-black/[0.66]">
            拿到 API Key 后，在 Mona 设置中配置 Agnes AI 即可激活全部能力。三类模型共用同一把 Key。
          </p>

          <div className="space-y-4">
            {monaSteps.map((step, index) => (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  duration: 0.4,
                  delay: index * 0.06,
                  ease: "easeOut",
                }}
                className="flex items-start gap-4 rounded-xl border border-black/10 bg-white/[0.6] p-6 backdrop-blur-sm"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/[0.04]">
                  <step.icon className="h-5 w-5 text-black/[0.66]" />
                </div>
                <div className="flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="font-mono text-sm font-bold text-black/[0.30]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-base font-semibold">{step.title}</h3>
                  </div>
                  <p className="text-sm leading-7 text-black/[0.66]">
                    {step.desc}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Key info callout */}
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50/[0.5] p-6">
            <div className="flex items-start gap-3">
              <Key className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-sm leading-7 text-black/[0.74]">
                <p className="mb-2 font-medium text-emerald-700">关键信息速查</p>
                <ul className="space-y-1.5 text-black/[0.66]">
                  <li>
                    <strong>Base URL：</strong>
                    <code className="rounded bg-white/60 px-1.5 py-0.5 font-mono text-xs">
                      https://apihub.agnes-ai.com/v1
                    </code>
                  </li>
                  <li>
                    <strong>认证：</strong>
                    <code className="rounded bg-white/60 px-1.5 py-0.5 font-mono text-xs">
                      Authorization: Bearer YOUR_API_KEY
                    </code>
                  </li>
                  <li>
                    <strong>LLM 模型：</strong>agnes-2.0-flash
                  </li>
                  <li>
                    <strong>图像模型：</strong>agnes-image-2.1-flash
                  </li>
                  <li>
                    <strong>视频模型：</strong>agnes-video-v2.0
                  </li>
                  <li>
                    <strong>费用：</strong>三类模型当前均为 $0，完全免费
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* CTA */}
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={AGNES_PLATFORM}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-black bg-[#101010] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
            >
              <Key className="h-4 w-4" />
              获取 API Key
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
