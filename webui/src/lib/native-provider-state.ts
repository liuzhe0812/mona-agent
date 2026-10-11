import { create } from "zustand";

// A probe updates the server catalog; every mounted consumer must reread it.
export const useNativeProviderState = create(() => ({ revision: 0 }));
export function nativeProvidersChanged() {
  useNativeProviderState.setState((state) => ({ revision: state.revision + 1 }));
}
