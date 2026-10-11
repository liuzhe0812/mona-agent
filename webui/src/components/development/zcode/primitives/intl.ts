import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import enUS from "./locales/en-US.js";
import zhCN from "./locales/zh-CN.js";

const messages = { "zh-CN": zhCN, en: enUS };

export function useZCodeIntl() {
  const { i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language).startsWith("en") ? "en" : "zh-CN";

  return useMemo(() => ({
    intl: {
      formatMessage(
        descriptor: { id: string },
        values?: Record<string, string | number>,
      ): string {
        let message = messages[locale][descriptor.id] ?? descriptor.id;
        for (const [name, value] of Object.entries(values ?? {})) {
          message = message.replaceAll(`{${name}}`, String(value));
        }
        return message;
      },
    },
    locale,
  }), [locale]);
}
