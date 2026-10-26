import { createInstance } from "i18next";
import { useTranslation as useReactTranslation } from "react-i18next";
import zh from "./locales/zh-CN.json";
import en from "./locales/en.json";

const i18n = createInstance();
void i18n.init({ lng: "zh-CN", fallbackLng: "en", resources: { "zh-CN": { translation: { ...zh, monaNative: { tradeReason_signal: "策略信号", equity: "账户资金", drawdown: "回撤%", saveImage: "保存图表", resetView: "重置视图", working: "正在执行原生因子评测", checkStatus: "继续查看进度", choose: "请选择", required: "请填写因子库、研究范围和时间区间。", topHelp: "这是原生报告保留的因子数量，不是选股数量。页面摘要沿用原生规则，最多展示前 5 项。", invalidTop: "请填写原生允许范围内的整数结果数量。", defaultsError: "因子评测的默认设置读取失败，可重新打开页面，或自行填写必需设置。" } } }, en: { translation: { ...en, monaNative: { tradeReason_signal: "Strategy signal", equity: "Equity", drawdown: "Drawdown%", saveImage: "Save chart", resetView: "Reset view", working: "Native factor evaluation is running", checkStatus: "Check current status", choose: "Select", required: "Choose the factor zoo, universe and period.", topHelp: "Number of factors kept in the native report, not number of stocks. The original summary shows at most five factors.", invalidTop: "Enter an integer within the supported result limit.", defaultsError: "Could not read factor evaluation defaults. Reopen this view or enter the required settings." } } } }, initAsync: false, interpolation: { escapeValue: false }, returnNull: false });
export function useTranslation() { return useReactTranslation(undefined, { i18n }); }
export default i18n;
