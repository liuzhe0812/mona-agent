import { useState } from "react";
import { useLicense } from "@/hooks/useLicense";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SubscribeView } from "./SubscribeView";

type AuthView = "login" | "register" | "forgot" | "reset" | "subscribe";

export function AuthPage() {
  const { login, register, forgotPassword, resetPassword, licenseInfo, loggedIn, deviceMismatch, bindDevice, logout } = useLicense();
  const [view, setView] = useState<AuthView>("login");
  const [email, setEmail] = useState("");
  const [accountInput, setAccountInput] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(accountInput, password);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (accountInput.trim().length < 2) {
      setError("账号至少需要2个字符");
      return;
    }
    if (password.length < 8) {
      setError("密码至少需要8个字符");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      await register(email, password, code, accountInput.trim());
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
      setSuccess(msg || "Verification code sent");
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
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await resetPassword(email, code, newPassword);
      setSuccess("Password reset successfully, please login");
      setView("login");
      setNewPassword("");
      setCode("");
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const handleBindDevice = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await bindDevice();
      if (!result.success) {
        setError("Failed to bind device. You may have exceeded the device change limit.");
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  // Device mismatch screen
  if (deviceMismatch) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex w-full max-w-sm flex-col gap-4 px-6 text-center">
          <p className="text-lg font-semibold">Device Mismatch</p>
          <p className="text-sm text-muted-foreground">
            This account is bound to another device. Trial accounts can change device once.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleBindDevice} disabled={loading}>
            {loading ? "Binding..." : "Bind to This Device"}
          </Button>
          <Button variant="outline" onClick={logout}>
            Sign in with another account
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
          {view === "login" && <p className="text-sm text-muted-foreground">Sign in to continue</p>}
          {view === "register" && <p className="text-sm text-muted-foreground">Create an account</p>}
          {view === "forgot" && <p className="text-sm text-muted-foreground">Reset your password</p>}
          {view === "reset" && <p className="text-sm text-muted-foreground">Enter verification code</p>}
        </div>

        {error && <p className="text-center text-sm text-destructive">{error}</p>}
        {success && <p className="text-center text-sm text-green-600">{success}</p>}

        {licenseInfo?.status === "expired" && loggedIn && (
          <div className="rounded-lg border border-border bg-muted/50 p-3 text-center text-sm text-muted-foreground">
            订阅已过期。
            <button
              type="button"
              className="ml-1 text-primary hover:underline"
              onClick={() => setView("subscribe")}
            >
              立即续费
            </button>
          </div>
        )}

        {view === "login" && (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <Input type="text" placeholder="账号或邮箱" value={accountInput} onChange={(e) => setAccountInput(e.target.value)} disabled={loading} autoFocus />
            <Input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
            <Button type="submit" className="w-full" disabled={!accountInput || !password || loading}>
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
            <button
              type="button"
              className="text-center text-xs text-muted-foreground hover:underline"
              onClick={() => { setView("subscribe"); setError(""); setSuccess(""); }}
            >
              购买订阅
            </button>
          </form>
        )}

        {view === "register" && (
          <form onSubmit={handleRegister} className="flex flex-col gap-3">
            <Input type="text" placeholder="账号（支持中文，2-32字符）" value={accountInput} onChange={(e) => setAccountInput(e.target.value)} disabled={loading} autoFocus />
            <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
            <Input type="password" placeholder="设置密码（至少8位）" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
            <div className="flex flex-col gap-1">
              <Input
                type="password"
                placeholder="确认密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                className={passwordMismatch ? "ring-1 ring-destructive" : ""}
              />
              {passwordMismatch && (
                <p className="text-xs text-destructive">两次输入的密码不一致</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={!accountInput || !email || !password || !confirmPassword || passwordMismatch || loading}>
              {loading ? "创建中..." : "创建账号"}
            </Button>
            <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
              已有账号？登录
            </button>
            <button
              type="button"
              className="text-center text-xs text-muted-foreground hover:underline"
              onClick={() => { setView("subscribe"); setError(""); setSuccess(""); }}
            >
              购买订阅
            </button>
          </form>
        )}

        {view === "forgot" && (
          <form onSubmit={handleForgot} className="flex flex-col gap-3">
            <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} autoFocus />
            <Button type="submit" className="w-full" disabled={!email || loading}>
              {loading ? "Sending..." : "Send Verification Code"}
            </Button>
            <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
              Back to sign in
            </button>
          </form>
        )}

        {view === "reset" && (
          <form onSubmit={handleReset} className="flex flex-col gap-3">
            <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
            <Input type="text" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} disabled={loading} maxLength={6} />
            <Input type="password" placeholder="New password (8+ characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={loading} />
            <Button type="submit" className="w-full" disabled={!email || !code || !newPassword || loading}>
              {loading ? "Resetting..." : "Reset Password"}
            </Button>
            <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
              Back to sign in
            </button>
          </form>
        )}

        {view === "subscribe" && (
          <SubscribeView
            userEmail={licenseInfo?.email || email}
            onBackToLogin={() => setView("login")}
          />
        )}
      </div>
    </div>
  );
}
