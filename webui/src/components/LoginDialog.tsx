import { useEffect, useState } from "react";
import { useLicense } from "@/hooks/useLicense";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SubscribeView } from "./SubscribeView";
import { ManageSubscription } from "./ManageSubscription";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type LoginView = "login" | "register" | "forgot" | "reset" | "subscribe" | "manage" | "change";

export function LoginDialog({
  open,
  onOpenChange,
  initialView = "login",
  autoSubscribeAfterLogin = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView?: LoginView;
  autoSubscribeAfterLogin?: boolean;
}) {
  const { login, register, sendRegisterCode, forgotPassword, resetPassword, changePassword, loggedIn, logout, licenseInfo, pricingConfig, fetchPricing } = useLicense();
  const [view, setView] = useState<LoginView>(initialView);
  const [email, setEmail] = useState("");
  const [accountInput, setAccountInput] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registerCode, setRegisterCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [subscribeLoading, setSubscribeLoading] = useState(false);
  const [pendingSubscribe, setPendingSubscribe] = useState(false);

  useEffect(() => {
    if (open) {
      setView(initialView);
      setPendingSubscribe(autoSubscribeAfterLogin && initialView !== "subscribe");
      setSubscribeLoading(initialView === "subscribe" && !pricingConfig);
    }
  }, [open, initialView, pricingConfig, autoSubscribeAfterLogin]);

  useEffect(() => {
    if (open && view === "subscribe") {
      fetchPricing();
    }
  }, [open, view, fetchPricing]);

  useEffect(() => {
    if (!open || view !== "subscribe") return;
    if (pricingConfig) {
      const timer = window.setTimeout(() => setSubscribeLoading(false), 150);
      return () => window.clearTimeout(timer);
    }
    const fallbackTimer = window.setTimeout(() => setSubscribeLoading(false), 1500);
    return () => window.clearTimeout(fallbackTimer);
  }, [open, view, pricingConfig]);

  const handleClose = (v: boolean) => {
    if (!v) {
      setView("login");
      setError("");
      setSuccess("");
      setRegisterCode("");
      setResetCode("");
      setOldPassword("");
      setNewPassword("");
      setCodeSent(false);
    }
    onOpenChange(v);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(accountInput, password);
      if (pendingSubscribe) {
        setPendingSubscribe(false);
        setView("subscribe");
      } else {
        handleClose(false);
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const handleSendCode = async () => {
    if (!accountInput.trim()) {
      setError("请先输入账号");
      return;
    }
    if (!email) {
      setError("请先输入邮箱");
      return;
    }
    setError("");
    try {
      await sendRegisterCode(email, accountInput.trim());
      setCodeSent(true);
      setSuccess("验证码已发送");
      setCodeCooldown(60);
      const timer = setInterval(() => {
        setCodeCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (accountInput.trim().length < 2) {
      setError("账号至少 2 位");
      return;
    }
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    if (!registerCode) {
      setError("请输入验证码");
      return;
    }
    setLoading(true);
    try {
      await register(email, password, registerCode, accountInput.trim());
      if (pendingSubscribe) {
        setPendingSubscribe(false);
        setView("subscribe");
      } else {
        handleClose(false);
      }
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
      await resetPassword(email, resetCode, newPassword);
      setSuccess("密码重置成功，请登录");
      setView("login");
      setNewPassword("");
      setResetCode("");
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (newPassword === oldPassword) {
      setError("新密码不能与旧密码相同");
      return;
    }
    setLoading(true);
    try {
      const msg = await changePassword(oldPassword, newPassword);
      setSuccess(msg || "密码修改成功");
      setOldPassword("");
      setNewPassword("");
      setView("login");
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const isSubscribeView = view === "subscribe";
  const isManageView = view === "manage";
  const showAccountInfo = loggedIn && view === "login";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={isSubscribeView || isManageView ? "sm:max-w-lg" : "sm:max-w-sm"}>
        <DialogHeader>
          <DialogTitle>
            {isSubscribeView
              ? "购买订阅"
              : isManageView
                ? "订阅管理"
                : showAccountInfo
                  ? "账号信息"
                  : view === "login"
                    ? "登录"
                    : view === "register"
                      ? "注册"
                      : view === "forgot"
                      ? "找回密码"
                      : view === "reset"
                      ? "重置密码"
                      : "修改密码"}
          </DialogTitle>
        </DialogHeader>

        {isSubscribeView && (
          <SubscribeView
            userEmail={licenseInfo?.account || licenseInfo?.email || email}
            onBackToLogin={() => setView(loggedIn ? "login" : "login")}
            embed
            loading={subscribeLoading}
            onManageSubscription={() => setView("manage")}
          />
        )}

        {isManageView && (
          <ManageSubscription onBack={() => setView("subscribe")} />
        )}

        {showAccountInfo && (
          <div className="flex flex-col gap-3 text-sm">
            {licenseInfo?.account && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">账号</span>
                <span>{licenseInfo.account}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">邮箱</span>
              <span>{licenseInfo?.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">授权状态</span>
              <span>{licenseInfo?.status === "valid" ? "有效" : licenseInfo?.status === "expired" ? "已过期" : licenseInfo?.status === "device_mismatch" ? "设备不匹配" : "无"}</span>
            </div>
            {licenseInfo?.expires_at && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">到期时间</span>
                <span>{licenseInfo.expires_at}</span>
              </div>
            )}
            {licenseInfo?.trial && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">类型</span>
                <span>试用</span>
              </div>
            )}
            <Button
              variant="outline"
              onClick={() => { setView("change"); setError(""); setSuccess(""); setOldPassword(""); setNewPassword(""); }}
            >
              修改密码
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                await logout();
                setView("login");
              }}
            >
              退出登录
            </Button>
          </div>
        )}

        {!isSubscribeView && !showAccountInfo && (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-green-600">{success}</p>}

            {view === "login" && (
              <form onSubmit={handleLogin} className="flex flex-col gap-3">
                <Input type="text" placeholder="账号或邮箱" value={accountInput} onChange={(e) => setAccountInput(e.target.value)} disabled={loading} autoFocus />
                <Input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
                <Button type="submit" disabled={!accountInput || !password || loading}>
                  {loading ? "登录中..." : "登录"}
                </Button>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <button type="button" className="hover:underline" onClick={() => { setView("forgot"); setError(""); setSuccess(""); }}>
                    忘记密码？
                  </button>
                  <button type="button" className="hover:underline" onClick={() => { setView("register"); setError(""); setSuccess(""); setCodeSent(false); }}>
                    注册新账号
                  </button>
                </div>
              </form>
            )}

            {view === "register" && (
              <form onSubmit={handleRegister} className="flex flex-col gap-3">
                <Input type="text" placeholder="账号（支持中文，2-32字符）" value={accountInput} onChange={(e) => setAccountInput(e.target.value)} disabled={loading} autoFocus />
                <Input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
                <div className="flex gap-2">
                  <Input type="text" placeholder="6 位验证码" value={registerCode} onChange={(e) => setRegisterCode(e.target.value)} disabled={loading} maxLength={6} className="flex-1" />
                  <Button type="button" variant="outline" onClick={handleSendCode} disabled={!accountInput.trim() || !email || codeCooldown > 0 || loading} className="shrink-0 whitespace-nowrap">
                    {codeCooldown > 0 ? `${codeCooldown}s` : codeSent ? "重新发送" : "获取验证码"}
                  </Button>
                </div>
                <Input type="password" placeholder="密码（至少 8 位）" value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
                <Input type="password" placeholder="确认密码" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={loading} className={passwordMismatch ? "ring-1 ring-destructive" : ""} />
                <Button type="submit" disabled={!accountInput || !email || !registerCode || !password || !confirmPassword || passwordMismatch || loading}>
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
                <Button type="submit" disabled={!email || loading}>
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
                <Input type="text" placeholder="6 位验证码" value={resetCode} onChange={(e) => setResetCode(e.target.value)} disabled={loading} maxLength={6} />
                <Input type="password" placeholder="新密码（至少 8 位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={loading} />
                <Button type="submit" disabled={!email || !resetCode || !newPassword || loading}>
                  {loading ? "重置中..." : "重置密码"}
                </Button>
                <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); }}>
                  返回登录
                </button>
              </form>
            )}

            {view === "change" && (
              <form onSubmit={handleChangePassword} className="flex flex-col gap-3">
                <Input type="password" placeholder="旧密码" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} disabled={loading} autoFocus />
                <Input type="password" placeholder="新密码（至少 8 位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={loading} />
                <Button type="submit" disabled={!oldPassword || !newPassword || loading}>
                  {loading ? "修改中..." : "修改密码"}
                </Button>
                <button type="button" className="text-center text-xs text-muted-foreground hover:underline" onClick={() => { setView("login"); setError(""); setSuccess(""); setOldPassword(""); setNewPassword(""); }}>
                  返回账号信息
                </button>
              </form>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
