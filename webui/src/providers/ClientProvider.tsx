import { createContext, useContext, type ReactNode } from "react";

import type { MonaClient } from "@/lib/mona-client";

export type RuntimeStatus = "connecting" | "error" | "auth" | "ready";

interface ClientContextValue {
  client: MonaClient | null;
  token: string;
  modelName: string | null;
  runtimeStatus: RuntimeStatus;
  runtimeError: string | null;
}

const ClientContext = createContext<ClientContextValue | null>(null);

export function ClientProvider({
  client,
  token,
  modelName = null,
  runtimeStatus,
  runtimeError = null,
  children,
}: {
  client: MonaClient | null;
  token: string;
  modelName?: string | null;
  runtimeStatus: RuntimeStatus;
  runtimeError?: string | null;
  children: ReactNode;
}) {
  return (
    <ClientContext.Provider
      value={{ client, token, modelName, runtimeStatus, runtimeError }}
    >
      {children}
    </ClientContext.Provider>
  );
}

/** Nullable variant for components that may render outside a provider
 *  (bare unit-test renders); unlike ``useClientOptional`` it never throws. */
export function useClientContextOrNull(): ClientContextValue | null {
  return useContext(ClientContext);
}

export function useClientOptional(): ClientContextValue {
  const ctx = useContext(ClientContext);
  if (!ctx) {
    throw new Error("useClientOptional must be used within a ClientProvider");
  }
  return ctx;
}

export function useClient(): ClientContextValue & { client: MonaClient } {
  const ctx = useContext(ClientContext);
  if (!ctx) {
    throw new Error("useClient must be used within a ClientProvider");
  }
  if (!ctx.client) {
    throw new Error("useClient called before the runtime client was ready");
  }
  return ctx as ClientContextValue & { client: MonaClient };
}
