import { createContext, useContext, type ReactNode } from "react";
const ErrorContext = createContext<{ onError: (message: string) => void; onOpenSettings?: () => void }>({ onError: () => {} });
export function NativeErrorProvider({ onError, onOpenSettings, children }: { onError: (message: string) => void; onOpenSettings?: () => void; children: ReactNode }) { return <ErrorContext.Provider value={{ onError, onOpenSettings }}>{children}</ErrorContext.Provider>; }
export function useNativeToast() { return { error: useContext(ErrorContext).onError }; }
export function useNativeSettings() { return useContext(ErrorContext).onOpenSettings; }
