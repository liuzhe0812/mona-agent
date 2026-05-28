import { useState, useEffect } from "react";
import {
  Lock,
  User,
  Server,
  Eye,
  EyeOff,
  Shield,
  Loader2,
} from "lucide-react";

interface DesktopLoginProps {
  onLogin: (config: {
    host: string;
    port: number;
    username: string;
    auth: { type: "password"; password: string };
  }) => void;
  loading?: boolean;
  error?: string | null;
}

export function DesktopLogin({ onLogin, loading, error }: DesktopLoginProps) {
  const [loginType, setLoginType] = useState<"password" | "key">("password");
  const [showPassword, setShowPassword] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("正在初始化...");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (loading) {
      setProgress(0);
      setStatusText("正在初始化...");
      const stages = [
        { p: 10, t: "正在解析主机地址..." },
        { p: 30, t: "正在建立加密通道..." },
        { p: 50, t: "正在进行SSH握手..." },
        { p: 70, t: "正在验证身份凭证..." },
        { p: 85, t: "正在配置会话环境..." },
        { p: 95, t: "等待服务器响应..." },
      ];
      let currentStage = 0;
      const interval = setInterval(() => {
        if (currentStage < stages.length) {
          setProgress(stages[currentStage].p);
          setStatusText(stages[currentStage].t);
          currentStage++;
        }
      }, 500);
      return () => clearInterval(interval);
    } else {
      setProgress(0);
    }
  }, [loading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin({
      host,
      port,
      username,
      auth: { type: "password", password },
    });
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[rgba(30,30,46,0.85)] p-8 backdrop-blur-xl">
        {loading ? (
          <div className="flex flex-col items-center justify-center space-y-6 py-8">
            <div className="relative">
              <div className="absolute inset-0 animate-pulse rounded-full bg-blue-500/30 blur-xl" />
              <div className="relative z-10 flex h-20 w-20 items-center justify-center rounded-full border border-white/20 bg-white/10">
                <Server className="h-10 w-10 animate-pulse text-blue-400" />
              </div>
              <div className="absolute -bottom-1 -right-1 z-20 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#1a1b26] bg-green-500">
                <Loader2 className="h-3 w-3 animate-spin text-white" />
              </div>
            </div>

            <div className="w-full space-y-2 text-center">
              <h2 className="text-xl font-bold text-white">正在连接服务器</h2>
              <p className="text-sm text-white/60">
                {username}@{host}
              </p>
            </div>

            <div className="w-full space-y-2">
              <div className="flex justify-between px-1 text-xs text-white/50">
                <span>{statusText}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="relative h-full bg-blue-500 transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                >
                  <div className="absolute inset-0 h-full w-full animate-pulse bg-white/20 skew-x-12" />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-8 text-center">
              <h1 className="mb-2 text-3xl font-bold text-white">
                <span className="text-blue-400">SSH</span> 桌面
              </h1>
              <p className="text-sm text-white/50">连接到远程服务器桌面环境</p>
            </div>

            <div className="mb-6 flex rounded-lg bg-black/30 p-1">
              <button
                type="button"
                onClick={() => setLoginType("password")}
                className={`flex-1 rounded-md py-2.5 text-sm font-medium transition-all ${
                  loginType === "password"
                    ? "bg-white/10 text-white"
                    : "text-white/60 hover:text-white/80"
                }`}
              >
                密码登录
              </button>
              <button
                type="button"
                onClick={() => setLoginType("key")}
                className={`flex-1 rounded-md py-2.5 text-sm font-medium transition-all ${
                  loginType === "key"
                    ? "bg-white/10 text-white"
                    : "text-white/60 hover:text-white/80"
                }`}
              >
                证书登录
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex gap-3">
                <div className="flex flex-1 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
                  <Server className="h-4 w-4 shrink-0 text-white/40" />
                  <input
                    type="text"
                    placeholder="主机地址"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                    autoFocus
                  />
                </div>
                <div className="flex w-20 items-center justify-center rounded-lg border border-white/10 bg-black/20 px-0">
                  <input
                    type="number"
                    value={port}
                    onChange={(e) =>
                      setPort(parseInt(e.target.value) || 22)
                    }
                    className="w-full border-none bg-transparent text-center text-sm text-white outline-none placeholder:text-white/40"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
                <User className="h-4 w-4 shrink-0 text-white/40" />
                <input
                  type="text"
                  placeholder="用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                />
              </div>

              {loginType === "password" ? (
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
                  <Lock className="h-4 w-4 shrink-0 text-white/40" />
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="ml-2 text-white/40 hover:text-white/60"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5">
                  <Shield className="h-4 w-4 shrink-0 text-white/40" />
                  <input
                    type="text"
                    placeholder="私钥路径（如 ~/.ssh/id_rsa）"
                    className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                  />
                </div>
              )}

              {error && (
                <div className="rounded border border-red-500/50 bg-red-500/20 px-3 py-2 text-center text-sm text-red-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !host || !username}
                className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                连接
              </button>
            </form>

            <div className="mt-6 text-center">
              <div className="flex items-center justify-center gap-2 text-sm text-green-400">
                <Shield className="h-4 w-4" />
                <span>连接数据加密传输</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
