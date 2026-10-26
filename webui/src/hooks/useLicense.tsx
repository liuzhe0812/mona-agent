import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { parseDeviceRemoval, requireLoginAccepted, type DeviceLoginOptions, type DeviceRemovalResult, type DeviceReplacement } from "@/lib/account-devices";

interface LicenseInfo {
  status: string;
  expires_at: string | null;
  trial: boolean;
  remaining_days?: number;
  plan?: "free" | "pro";
  device_limit?: number;
  device_session_id?: string;
  logged_in?: boolean;
  offline?: boolean;
  email: string | null;
  account: string | null;
}

interface PricingPlan {
  id: string;
  name: string;
  price: number;
  durationMonths?: number;
  periodDays?: number;
  autoRenewable?: boolean;
  originalPrice?: number;
  badge?: string;
}

interface PromoTrial {
  enabled: boolean;
  days: number;
  end_at: string | null;
}

interface PricingConfig {
  plans: PricingPlan[];
  contact: { email: string; wechat: string };
  promotionalBanner: string | null;
  promoTrial: PromoTrial | null;
}

interface LicenseContextValue {
  licenseActive: boolean;
  checking: boolean;
  licenseInfo: LicenseInfo | null;
  loggedIn: boolean;
  serverTrial: boolean;
  remainingDays: number;
  pricingConfig: PricingConfig | null;
  pricingError: string | null;
  fetchPricing: () => Promise<void>;
  login: (account: string, password: string, options?: DeviceLoginOptions) => Promise<void>;
  register: (email: string, password: string, code: string, account: string) => Promise<void>;
  sendRegisterCode: (email: string, account: string) => Promise<string>;
  logout: () => Promise<void>;
  removeLoginDevice: (device: DeviceReplacement) => Promise<DeviceRemovalResult>;
  forgotPassword: (email: string) => Promise<string>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<string>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<string>;
  refreshLicense: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({
  licenseActive: false,
  checking: true,
  licenseInfo: null,
  loggedIn: false,
  serverTrial: false,
  remainingDays: 0,
  pricingConfig: null,
  pricingError: null,
  fetchPricing: async () => {},
  login: async () => {},
  register: async () => {},
  sendRegisterCode: async () => "",
  logout: async () => {},
  removeLoginDevice: async () => { throw new Error("账号状态未就绪，请重新打开设置。"); },
  forgotPassword: async () => "",
  resetPassword: async () => "",
  changePassword: async () => "",
  refreshLicense: async () => {},
});

function remainingDaysUntil(expiresAt: string | null): number {
  if (!expiresAt) return 0;
  const expires = new Date(expiresAt.includes("T") ? expiresAt : `${expiresAt}T23:59:59Z`).getTime();
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.ceil((expires - Date.now()) / 86_400_000));
}

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [licenseActive, setLicenseActive] = useState(false);
  const [checking, setChecking] = useState(true);
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [serverTrial, setServerTrial] = useState(false);
  const [remainingDays, setRemainingDays] = useState(0);
  const [pricingConfig, setPricingConfig] = useState<PricingConfig | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const licenseCheckGeneration = useRef(0);
  const authMutationGeneration = useRef(0);

  const invokeTauri = useCallback(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }, []);

  const checkLicense = useCallback(async () => {
    const generation = ++licenseCheckGeneration.current;
    if (!isTauri()) {
      if (licenseCheckGeneration.current === generation) {
        setLicenseActive(false);
        setChecking(false);
      }
      return;
    }
    try {
      const result = await invokeTauri<LicenseInfo>("check_account_status");
      if (licenseCheckGeneration.current !== generation) return;
      setLicenseInfo(result);
      setLicenseActive(result.status === "valid");
      // 登录状态基于是否有账号信息
      const hasAccount = result.logged_in !== false && !!(result.email || result.account);
      setLoggedIn(hasAccount);
      setServerTrial(!!result.trial && result.status === "valid");
      setRemainingDays(result.remaining_days ?? remainingDaysUntil(result.expires_at));
    } catch {
      if (licenseCheckGeneration.current === generation) setLicenseActive(false);
    } finally {
      if (licenseCheckGeneration.current === generation) setChecking(false);
    }
  }, [invokeTauri]);

  const fetchPricing = useCallback(async () => {
    setPricingError(null);
    try {
      let raw: unknown;
      if (isTauri()) {
        raw = await invokeTauri<Record<string, unknown>>("get_pricing");
      } else {
        let resp: Response;
        try {
          resp = await fetch("https://mona-ai.cn/config/pricing");
          if (!resp.ok) throw new Error(`fetch pricing failed: ${resp.status}`);
        } catch {
          resp = await fetch("https://www.mona-ai.cn/config/pricing");
          if (!resp.ok) throw new Error(`fetch pricing failed: ${resp.status}`);
        }
        raw = await resp.json();
      }
      const data = raw as Record<string, unknown>;
      const plans = (data.plans as Record<string, unknown>[] | undefined) ?? [];
      setPricingConfig({
        plans: plans.map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? ""),
          price: Number(p.price ?? 0),
          durationMonths: p.duration_months != null ? Number(p.duration_months) : undefined,
          periodDays: p.period_days != null ? Number(p.period_days) : undefined,
          autoRenewable: p.auto_renewable != null ? Boolean(p.auto_renewable) : undefined,
          originalPrice: p.original_price != null ? Number(p.original_price) : undefined,
          badge: p.badge ? String(p.badge) : undefined,
        })),
        contact: {
          email: String((data.contact as Record<string, unknown> | undefined)?.email ?? ""),
          wechat: String((data.contact as Record<string, unknown> | undefined)?.wechat ?? ""),
        },
        promotionalBanner:
          data.promotional_banner != null ? String(data.promotional_banner) : null,
        promoTrial: data.promo_trial
          ? {
              enabled: Boolean((data.promo_trial as Record<string, unknown>).enabled),
              days: Number((data.promo_trial as Record<string, unknown>).days ?? 0),
              end_at:
                (data.promo_trial as Record<string, unknown>).end_at != null
                  ? String((data.promo_trial as Record<string, unknown>).end_at)
                  : null,
            }
          : null,
      });
    } catch (err) {
      setPricingConfig(null);
      setPricingError(String(err));
      console.error("fetchPricing failed:", err);
    }
  }, [invokeTauri]);

  const clearAccountState = useCallback(() => {
    licenseCheckGeneration.current += 1;
    setLoggedIn(false);
    setLicenseActive(false);
    setLicenseInfo(null);
    setServerTrial(false);
    setRemainingDays(0);
    setChecking(false);
  }, []);

  const wakeCloudSyncAfterLogin = useCallback(async (mutation: number) => {
    if (authMutationGeneration.current !== mutation) return;
    try {
      const { cloudSyncApi } = await import("@/lib/cloud-sync");
      if (authMutationGeneration.current !== mutation) return;
      await cloudSyncApi.sync();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "sync_disabled") return;
      console.warn("Cloud sync wake after login failed");
    }
  }, []);

  const login = useCallback(async (account: string, password: string, options?: DeviceLoginOptions) => {
    const mutation = ++authMutationGeneration.current;
    licenseCheckGeneration.current += 1;
    const result = await invokeTauri<unknown>("auth_login", { account, password,
      requestId: options?.requestId ?? crypto.randomUUID().replaceAll("-", ""),
      replacements: options?.replacements ?? [],
    });
    requireLoginAccepted(result);
    if (authMutationGeneration.current !== mutation) return;
    setLoggedIn(true);
    await checkLicense();
    void wakeCloudSyncAfterLogin(mutation);
  }, [invokeTauri, checkLicense, wakeCloudSyncAfterLogin]);

  const register = useCallback(async (email: string, password: string, code: string, account: string) => {
    const mutation = ++authMutationGeneration.current;
    licenseCheckGeneration.current += 1;
    const result = await invokeTauri<unknown>("auth_register", { email, password, code, account });
    requireLoginAccepted(result);
    if (authMutationGeneration.current !== mutation) return;
    setLoggedIn(true);
    await checkLicense();
    void wakeCloudSyncAfterLogin(mutation);
  }, [invokeTauri, checkLicense, wakeCloudSyncAfterLogin]);

  const sendRegisterCode = useCallback(async (email: string, account: string): Promise<string> => {
    const result = await invokeTauri<{ success: boolean; message?: string }>("send_register_code", { email, account });
    return result.message || "";
  }, [invokeTauri]);

  const logout = useCallback(async () => {
    const mutation = ++authMutationGeneration.current;
    licenseCheckGeneration.current += 1;
    const result = await invokeTauri<{ success?: boolean }>("auth_logout");
    if (result?.success !== true) throw new Error("尚未确认退出结果，请联网后重试。");
    if (authMutationGeneration.current === mutation) clearAccountState();
  }, [invokeTauri, clearAccountState]);

  const removeLoginDevice = useCallback(async (device: DeviceReplacement): Promise<DeviceRemovalResult> => {
    const mutation = ++authMutationGeneration.current;
    licenseCheckGeneration.current += 1;
    const result = parseDeviceRemoval(await invokeTauri("revoke_login_device", { device }), device.id);
    if (authMutationGeneration.current === mutation && result.current_device_removed) clearAccountState();
    return result;
  }, [invokeTauri, clearAccountState]);

  const forgotPassword = useCallback(async (email: string): Promise<string> => {
    const result = await invokeTauri<{ success: boolean; message?: string }>("auth_forgot_password", { email });
    return result.message || "";
  }, [invokeTauri]);

  const resetPassword = useCallback(async (email: string, code: string, newPassword: string): Promise<string> => {
    const result = await invokeTauri<{ success: boolean; message?: string }>("auth_reset_password", {
      email, code, newPassword,
    });
    return result.message || "";
  }, [invokeTauri]);

  const changePassword = useCallback(async (oldPassword: string, newPassword: string): Promise<string> => {
    const result = await invokeTauri<{ success: boolean; message?: string }>("auth_change_password", {
      oldPassword, newPassword,
    });
    return result.message || "";
  }, [invokeTauri]);

  useEffect(() => {
    checkLicense();
    fetchPricing();
  }, [checkLicense, fetchPricing]);

  useEffect(() => {
    if (!isTauri() || !loggedIn) return;
    // Free accounts also need revocation checks; local tasks are not stopped.
    let lastCheck = Date.now();
    const refresh = () => {
      if (Date.now() - lastCheck < 300_000) return;
      lastCheck = Date.now();
      void checkLicense();
    };
    const timer = window.setInterval(refresh, 300_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [checkLicense, loggedIn]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ loggedIn?: boolean }>("auth-state-changed", ({ payload }) => {
        if (!disposed && payload.loggedIn === false) clearAccountState();
      }),
    ).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [clearAccountState]);

  return (
    <LicenseContext.Provider value={{
      licenseActive,
      checking,
      licenseInfo,
      loggedIn,
      serverTrial,
      remainingDays,
      pricingConfig,
      pricingError,
      fetchPricing,
      login,
      register,
      sendRegisterCode,
      logout,
      removeLoginDevice,
      forgotPassword,
      resetPassword,
      changePassword,
      refreshLicense: checkLicense,
    }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense(): LicenseContextValue {
  return useContext(LicenseContext);
}
