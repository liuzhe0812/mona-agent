import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";

interface LicenseInfo {
  status: string;
  expires_at: string | null;
  trial: boolean;
  remaining_days?: number;
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
  deviceMismatch: boolean;
  pricingConfig: PricingConfig | null;
  pricingError: string | null;
  fetchPricing: () => Promise<void>;
  login: (account: string, password: string) => Promise<void>;
  register: (email: string, password: string, code: string, account: string) => Promise<void>;
  sendRegisterCode: (email: string, account: string) => Promise<string>;
  logout: () => Promise<void>;
  forgotPassword: (email: string) => Promise<string>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<string>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<string>;
  bindDevice: () => Promise<{ success: boolean; remaining_changes?: number }>;
  refreshLicense: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({
  licenseActive: false,
  checking: true,
  licenseInfo: null,
  loggedIn: false,
  serverTrial: false,
  remainingDays: 0,
  deviceMismatch: false,
  pricingConfig: null,
  pricingError: null,
  fetchPricing: async () => {},
  login: async () => {},
  register: async () => {},
  sendRegisterCode: async () => "",
  logout: async () => {},
  forgotPassword: async () => "",
  resetPassword: async () => "",
  changePassword: async () => "",
  bindDevice: async () => ({ success: false }),
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
  const [deviceMismatch, setDeviceMismatch] = useState(false);
  const [pricingConfig, setPricingConfig] = useState<PricingConfig | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const licenseCheckGeneration = useRef(0);

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
      const result = await invokeTauri<LicenseInfo>("check_license");
      if (licenseCheckGeneration.current !== generation) return;
      setLicenseInfo(result);
      setLicenseActive(result.status === "valid");
      // 登录状态基于是否有账号信息
      const hasAccount = !!(result.email || result.account);
      setLoggedIn(hasAccount);
      setServerTrial(!!result.trial && result.status === "valid");
      setRemainingDays(result.remaining_days ?? remainingDaysUntil(result.expires_at));
      setDeviceMismatch(result.status === "device_mismatch");
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

  const login = useCallback(async (account: string, password: string) => {
    const result = await invokeTauri<{ success: boolean }>("auth_login", { account, password });
    if (result.success) {
      setLoggedIn(true);
      await checkLicense();
    }
  }, [invokeTauri, checkLicense]);

  const register = useCallback(async (email: string, password: string, code: string, account: string) => {
    const result = await invokeTauri<{ success: boolean }>("auth_register", { email, password, code, account });
    if (result.success) {
      setLoggedIn(true);
      await checkLicense();
    }
  }, [invokeTauri, checkLicense]);

  const sendRegisterCode = useCallback(async (email: string, account: string): Promise<string> => {
    const result = await invokeTauri<{ success: boolean; message?: string }>("send_register_code", { email, account });
    return result.message || "";
  }, [invokeTauri]);

  const logout = useCallback(async () => {
    licenseCheckGeneration.current += 1;
    await invokeTauri("auth_logout");
    setLoggedIn(false);
    setLicenseActive(false);
    setLicenseInfo(null);
    setServerTrial(false);
    setDeviceMismatch(false);
  }, [invokeTauri]);

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

  const bindDevice = useCallback(async (): Promise<{ success: boolean; remaining_changes?: number }> => {
    try {
      const result = await invokeTauri<{ success: boolean; remaining_changes?: number }>("bind_device");
      if (result.success) {
        setDeviceMismatch(false);
        await checkLicense();
      }
      return result;
    } catch {
      return { success: false };
    }
  }, [invokeTauri, checkLicense]);

  useEffect(() => {
    checkLicense();
    fetchPricing();
  }, [checkLicense, fetchPricing]);

  useEffect(() => {
    if (!isTauri() || !licenseActive) return;
    const timer = window.setInterval(() => {
      void invokeTauri<boolean>("license_has_access")
        .then((hasAccess) => {
          if (!hasAccess) void checkLicense();
        })
        .catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [checkLicense, invokeTauri, licenseActive]);

  return (
    <LicenseContext.Provider value={{
      licenseActive,
      checking,
      licenseInfo,
      loggedIn,
      serverTrial,
      remainingDays,
      deviceMismatch,
      pricingConfig,
      pricingError,
      fetchPricing,
      login,
      register,
      sendRegisterCode,
      logout,
      forgotPassword,
      resetPassword,
      changePassword,
      bindDevice,
      refreshLicense: checkLicense,
    }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense(): LicenseContextValue {
  return useContext(LicenseContext);
}
