import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { AlphaZoo } from "./native/pages/AlphaZoo";
import { Compare } from "./native/pages/Compare";
import { Reports } from "./native/pages/Reports";
import { NativeErrorProvider } from "./native/lib/toast";
import "./native/native-tools.css";

export function StockVibeNativeFactors({ onError, onOpenSettings }: { onError: (message: string) => void; onOpenSettings?: () => void }) {
  return <NativeErrorProvider onError={onError} onOpenSettings={onOpenSettings}><div className="stock-vibe-native-tools"><MemoryRouter initialEntries={["/alpha-zoo"]}><Routes><Route path="/alpha-zoo" element={<AlphaZoo />} /><Route path="/alpha-zoo/bench" element={<AlphaZoo />} /><Route path="/alpha-zoo/compare" element={<AlphaZoo />} /><Route path="/alpha-zoo/:alphaId" element={<AlphaZoo />} /></Routes></MemoryRouter></div></NativeErrorProvider>;
}
function OpenReport({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const { runId } = useParams<{ runId: string }>(), navigate = useNavigate();
  useEffect(() => { if (runId && /^[A-Za-z0-9_-]{1,128}$/.test(runId)) onOpenRun(runId); navigate("/reports", { replace: true }); }, [navigate, onOpenRun, runId]);
  return null;
}
function ReportCompare() {
  const navigate = useNavigate();
  return <><Button variant="ghost" size="sm" onClick={() => navigate("/reports")}>返回回测报告</Button><Compare /></>;
}
export function StockVibeNativeReports({ onError, onOpenRun }: { onError: (message: string) => void; onOpenRun: (runId: string) => void }) {
  return <NativeErrorProvider onError={onError}><div className="stock-vibe-native-tools"><MemoryRouter initialEntries={["/reports"]}><Routes><Route path="/reports" element={<Reports />} /><Route path="/runs/:runId" element={<OpenReport onOpenRun={onOpenRun} />} /><Route path="/compare" element={<ReportCompare />} /></Routes></MemoryRouter></div></NativeErrorProvider>;
}
export function StockVibeNativeCompare({ onError, initialLeftRunId, initialRightRunId }: { onError: (message: string) => void; initialLeftRunId?: string; initialRightRunId?: string }) {
  return <NativeErrorProvider onError={onError}><div className="stock-vibe-native-tools"><Compare key={`${initialLeftRunId ?? ""}:${initialRightRunId ?? ""}`} initialLeftRunId={initialLeftRunId} initialRightRunId={initialRightRunId} /></div></NativeErrorProvider>;
}
export { EquityChart } from "./native/components/charts/EquityChart";
export { FactorResearchPanel } from "./native/components/charts/FactorResearchPanel";
export { ValidationPanel } from "./native/components/charts/ValidationPanel";
