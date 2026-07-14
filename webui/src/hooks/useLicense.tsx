import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";

interface LicenseInfo {
  status: string;
  expires_at: string | null;
  trial: boolean;
  local_trial?: boolean;
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

interface PricingConfig {
  plans: PricingPlan[];
  contact: { email: string; wechat: string };
  promotionalBanner: string | null;
}

interface LicenseContextValue {
  licenseActive: boolean;
  checking: boolean;
  licenseInfo: LicenseInfo | null;
  loggedIn: boolean;
  localTrial: boolean;
  localTrialExpired: boolean;
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
  bindDevice: () => Promise<{ success: boolean; remaining_changes?: number }>;
  refreshLicense: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({
  licenseActive: false,
  checking: true,
  licenseInfo: null,
  loggedIn: false,
  localTrial: false,
  localTrialExpired: false,
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
  bindDevice: async () => ({ success: false }),
  refreshLicense: async () => {},
});

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [licenseActive, setLicenseActive] = useState(false);
  const [checking, setChecking] = useState(true);
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [localTrial, setLocalTrial] = useState(false);
  const [localTrialExpired, setLocalTrialExpired] = useState(false);
  const [serverTrial, setServerTrial] = useState(false);
  const [remainingDays, setRemainingDays] = useState(0);
  const [deviceMismatch, setDeviceMismatch] = useState(false);
  const [pricingConfig, setPricingConfig] = useState<PricingConfig | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);

  const invokeTauri = useCallback(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }, []);

  const checkLicense = useCallback(async () => {
    if (!isTauri()) {
      setLicenseActive(false);
      setChecking(false);
      return;
    }
    try {
      const result = await invokeTauri<LicenseInfo>("check_license");
      setLicenseInfo(result);
      setLicenseActive(result.status === "valid");
      // 登录状态基于是否有账号信息，而非 status（本地试用也会返回 valid/expired 但无账号）
      const hasAccount = !!(result.email || result.account);
      setLoggedIn(hasAccount);
      setLocalTrial(!!result.local_trial && result.status === "valid");
      setLocalTrialExpired(!!result.local_trial && result.status === "expired");
      setServerTrial(!!result.trial && result.status === "valid" && !result.local_trial);
      setRemainingDays(result.remaining_days ?? 0);
      setDeviceMismatch(result.status === "device_mismatch");
    } catch {
      setLicenseActive(false);
    } finally {
      setChecking(false);
    }
  }, [invokeTauri]);

  const fetchPricing = useCallback(async () => {
    setPricingError(null);
    try {
      let raw: unknown;
      if (isTauri()) {
        raw = await invokeTauri<Record<string, unknown>>("get_pricing");
      } else {
        const resp = await fetch("https://mona.lzfun.vip/config/pricing");
        if (!resp.ok) throw new Error(`fetch pricing failed: ${resp.status}`);
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
    await invokeTauri("auth_logout");
    setLoggedIn(false);
    setLicenseActive(false);
    setLicenseInfo(null);
    setLocalTrial(false);
    setLocalTrialExpired(false);
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

  return (
    <LicenseContext.Provider value={{
      licenseActive,
      checking,
      licenseInfo,
      loggedIn,
      localTrial,
      localTrialExpired,
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
