import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";

interface LicenseContextValue {
  licenseActive: boolean;
  checking: boolean;
  refreshLicense: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({
  licenseActive: false,
  checking: true,
  refreshLicense: async () => {},
});

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [licenseActive, setLicenseActive] = useState(false);
  const [checking, setChecking] = useState(true);

  const checkLicense = useCallback(async () => {
    if (!isTauri()) {
      setLicenseActive(false);
      setChecking(false);
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ status: string; expires_at: string | null }>("check_license");
      setLicenseActive(result.status === "valid");
    } catch {
      setLicenseActive(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkLicense();
  }, [checkLicense]);

  return (
    <LicenseContext.Provider value={{ licenseActive, checking, refreshLicense: checkLicense }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense(): LicenseContextValue {
  return useContext(LicenseContext);
}
