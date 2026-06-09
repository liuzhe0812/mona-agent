import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";

interface LicenseInfo {
  status: string;
  expires_at: string | null;
  trial: boolean;
  local_trial?: boolean;
  remaining_days?: number;
  email: string | null;
}

interface LicenseContextValue {
  licenseActive: boolean;
  checking: boolean;
  licenseInfo: LicenseInfo | null;
  loggedIn: boolean;
  localTrial: boolean;
  localTrialExpired: boolean;
  remainingDays: number;
  deviceMismatch: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, code: string) => Promise<void>;
  sendRegisterCode: (email: string) => Promise<string>;
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
  remainingDays: 0,
  deviceMismatch: false,
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
  const [remainingDays, setRemainingDays] = useState(0);
  const [deviceMismatch, setDeviceMismatch] = useState(false);

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
      setLoggedIn(result.status !== "not_logged_in" && !result.local_trial);
      setLocalTrial(!!result.local_trial && result.status === "valid");
      setLocalTrialExpired(!!result.local_trial && result.status === "expired");
      setRemainingDays(result.remaining_days ?? 0);
      setDeviceMismatch(result.status === "device_mismatch");
    } catch {
      setLicenseActive(false);
    } finally {
      setChecking(false);
    }
  }, [invokeTauri]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await invokeTauri<{ success: boolean }>("auth_login", { email, password });
    if (result.success) {
      setLoggedIn(true);
      await checkLicense();
    }
  }, [invokeTauri, checkLicense]);

  const register = useCallback(async (email: string, password: string, code: string) => {
    const result = await invokeTauri<{ success: boolean }>("auth_register", { email, password, code });
    if (result.success) {
      setLoggedIn(true);
      await checkLicense();
    }
  }, [invokeTauri, checkLicense]);

  const sendRegisterCode = useCallback(async (email: string): Promise<string> => {
    const result = await invokeTauri<{ success: boolean; message?: string }>("send_register_code", { email });
    return result.message || "";
  }, [invokeTauri]);

  const logout = useCallback(async () => {
    await invokeTauri("auth_logout");
    setLoggedIn(false);
    setLicenseActive(false);
    setLicenseInfo(null);
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
  }, [checkLicense]);

  return (
    <LicenseContext.Provider value={{
      licenseActive,
      checking,
      licenseInfo,
      loggedIn,
      localTrial,
      localTrialExpired,
      remainingDays,
      deviceMismatch,
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
