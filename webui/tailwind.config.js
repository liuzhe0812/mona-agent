import animate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          '"Noto Sans"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          "sans-serif",
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          '"Cascadia Code"',
          '"Source Code Pro"',
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        // 命名圆角 Token（design §7.1）：rounded-xs~xl 即规范档位。
        // rounded-2xl 保持 Tailwind 默认 16px（= --radius-xl），主内容表面不变。
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      // 命名字阶（design §5.2）：业务页面禁止任意 text-[…]，使用命名角色
      fontSize: {
        micro: ["0.6875rem", { lineHeight: "1rem" }], // 11/16 时间戳、辅助计数
        caption: ["0.75rem", { lineHeight: "1.125rem" }], // 12/18 分组标签、状态
        ui: ["0.8125rem", { lineHeight: "1.25rem" }], // 13/20 桌面控件、列表
        body: ["0.875rem", { lineHeight: "1.375rem" }], // 14/22 默认正文
        "body-lg": ["1rem", { lineHeight: "1.625rem" }], // 16/26 对话/阅读正文
        "title-sm": ["1rem", { lineHeight: "1.5rem", fontWeight: "600" }], // 16/24 弹窗/区块标题
        title: ["1.25rem", { lineHeight: "1.75rem", fontWeight: "600" }], // 20/28 页面标题
        "display-sm": ["1.75rem", { lineHeight: "2.25rem" }], // 28/36 少量重点数字
        clock: ["3.375rem", { lineHeight: "3.75rem", fontWeight: "300" }], // 54/60 首页时间专用
      },
      // 语义阴影（design §7.3）：surface/float/overlay 与 shadow-sm/md/lg 同值，
      // 迁移期两套并存，UI-30 清理旧档位
      boxShadow: {
        surface: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        float: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        overlay:
          "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
      },
      // 动效 Token（design §9）
      transitionDuration: {
        instant: "var(--motion-instant)",
        fast: "var(--motion-fast)",
        standard: "var(--motion-standard)",
        arrival: "var(--motion-arrival)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
        entrance: "var(--ease-entrance)",
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        theme: "hsl(var(--theme))",
        action: {
          DEFAULT: "hsl(var(--action))",
          hover: "hsl(var(--action-hover))",
          foreground: "hsl(var(--action-foreground))",
        },
        // 语义状态色（design §4.4）：alpha 修饰符可用（如 bg-info-strong/[0.07]）
        info: {
          DEFAULT: "hsl(var(--info))",
          strong: "hsl(var(--info-strong))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          hover: "hsl(var(--success-hover))",
          indicator: "hsl(var(--success-indicator))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          hover: "hsl(var(--warning-hover))",
        },
        // A 股涨跌色（数据可视化例外）：text-stock-up / text-stock-down
        stock: {
          up: "hsl(var(--stock-up))",
          down: "hsl(var(--stock-down))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
        },
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [animate, typography],
};
