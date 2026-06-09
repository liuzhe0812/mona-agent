import { useState } from "react";
import { useLicense } from "@/hooks/useLicense";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AuthView = "idle" | "login" | "register" | "forgot" | "reset" | "device_mismatch";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const {
    licenseActive,
    checking,
    licenseInfo,
    loggedIn,
    deviceMismatch: dmFromHook,
    login,
    register,
    forgotPassword,
    resetPassword,
    bindDevice,
    logout,
  } = useLicense();

  const [view, setView] = useState<AuthView>("idle");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // If license is active, just render children
  if (licenseActive) {
    return <>{children}</>;
  }

  // Still checking
  if (checking) {
    return <>{children}</>;
  }

  // Device mismatch
  if (dmFromHook || view === "device_mismatch") {
    const handleBind = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await bindDevice();
        if (!result.success) {
          setError("Device change limit reached. Please subscribe to change devices freely.");
        }
      } catch (err) {
        setError(String(err).replace(/^Error:\s*/, ""));
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex w-full max-w-sm flex-col gap-4 px-6 text-center">
          <div className="text-4xl">🔒</div>
          <p className="text-lg font-semibold">设备不匹配</p>
          <p className="text-sm text-muted-foreground">
            此账号已绑定其他设备。试用账号可更换 1 次设备。
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleBind} disabled={loading}>
            {loading ? "绑定中..." : "绑定到当前设备"}
          </Button>
          <Button variant="outline" onClick={() => { logout(); setView("idle"); }}>
            使用其他账号登录
          </Button>
        </div>
      </div>
    );
  }

  // Logged in but expired
  if (loggedIn && licenseInfo?.status === "expired") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex w-full max-w-sm flex-col gap-4 px-6 text-center">
          <div className="text-4xl">⏰</div>
          <p className="text-lg font-semibold">试用已到期</p>
          <p className="text-sm text-muted-foreground">
            您的试用期已于 {licenseInfo.expires_at} 到期，请订阅以继续使用 AI 功能。
          </p>
          <Button onClick={() => window.open("https://mona.ai/pricing", "_blank")}>
            查看订阅方案
          </Button>
          <Button variant="outline" onClick={() => { logout(); setView("idle"); }}>
            切换账号
          </Button>
        </div>
      </div>
    );
  }

  // Logged in but some other issue (missing, etc.)
  if (loggedIn && licenseInfo?.status !== "valid") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex w-full max-w-sm flex-col gap-4 px-6 text-center">
          <div className="text-4xl">🔑</div>
          <p className="text-lg font-semibold">授权无效</p>
          <p className="text-sm text-muted-foreground">
            当前账号无有效授权，请订阅或联系管理员。
          </p>
          <Button variant="outline" onClick={() => { logout(); setView("idle"); }}>
            切换账号
          </Button>
        </div>
      </div>
    );
  }

  // Not logged in — show auth UI
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    setLoading(true);
    try {
      await register(email, password);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const msg = await forgotPassword(email);
      setSuccess(msg || "验证码已发送");
      setView("reset");
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    setLoading(true);
    try {
      await resetPassword(email, code, newPassword);
      setSuccess("密码重置成功，请登录");
      setView("login");
      setNewPassword("");
      setCode("");
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  // Default idle state — prompt to login
  if (view === "idle") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex w-full max-w-sm flex-col gap-4 px-6 text-center">
          <div className="text-4xl">✨</div>
          <p className="text-lg font-semibold">解锁 AI 功能</p>
          <p className="text-sm text-muted-foreground">
            登录账号即可免费试用 31 天 AI 助手功能
          </p>
          <Button onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
            登录
          </Button>
          <Button variant="outline" onClick={() => { setView("register"); setError(""); setSuccess(""); }}>
            注册新账号
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex w-full max-w-sm flex-col gap-4 px-6">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold">Mona</p>
          {view === "login" && <p className="text-sm text-muted-foreground">登录以解锁 AI 功能</p>}
          {view === "register" && <p className="text-sm text-muted-foreground">注册账号，免费试用 31 天</p>}
          {view === "forgot" && <p className="text-sm text-muted-foreground">重置密码</p>}
          {view === "reset" && <p className="text-sm text-muted-foreground">输入验证码</p>}
        </div>

        {error && <p className="text-center text-sm text-destructive">{error}</p>}
        {success && <p className="text-center text-sm text-green-600">{success}</p>}

        {view === "login" && (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} autoFocus />
            <Input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
            <Button type="submit" className="w-full" disabled={!email || !password || loading}>
              {loading ? "登录中..." : "登录"}
            </Button>
            <div className="flex justify-between text-xs text-muted-foreground">
              <button type="button" className="hover:underline" onClick={() => { setView("forgot"); setError(""); setSuccess(""); }}>
                忘记密码？
              </button>
              <button type="button" className="hover:underline" onClick={() => { setView("register"); setError(""); setSuccess(""); }}>
                注册账号
              </button>
            </div>
          </form>
        )}

        {view === "register" && (
          <form onSubmit={handleRegister} className="flex flex-col gap-3">
            <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} autoFocus />
            <Input type="password" placeholder="密码（至少 8 位）" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
            <Button type="submit" className="w-full" disabled={!email || !password || loading}>
              {loading ? "注册中..." : "注册"}
            </Button>
            <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
              已有账号？登录
            </button>
          </form>
        )}

        {view === "forgot" && (
          <form onSubmit={handleForgot} className="flex flex-col gap-3">
            <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} autoFocus />
            <Button type="submit" className="w-full" disabled={!email || loading}>
              {loading ? "发送中..." : "发送验证码"}
            </Button>
            <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
              返回登录
            </button>
          </form>
        )}

        {view === "reset" && (
          <form onSubmit={handleReset} className="flex flex-col gap-3">
            <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
            <Input type="text" placeholder="6 位验证码" value={code} onChange={(e) => setCode(e.target.value)} disabled={loading} maxLength={6} />
            <Input type="password" placeholder="新密码（至少 8 位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={loading} />
            <Button type="submit" className="w-full" disabled={!email || !code || !newPassword || loading}>
              {loading ? "重置中..." : "重置密码"}
            </Button>
            <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
              返回登录
            </button>
          </form>
        )}

        <button
          type="button"
          className="text-center text-xs text-muted-foreground hover:underline"
          onClick={() => { setView("idle"); setError(""); setSuccess(""); }}
        >
          暂不登录
        </button>
      </div>
    </div>
  );
}
