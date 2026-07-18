"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  STRINGS,
  format,
  pluralKey,
  type Locale,
} from "@/lib/i18n";

const STORAGE_KEY = "ts-ops-planner-locale-v1";

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Pick the plural form for `n` from keys `{base}.one/.few/.many/.other`.
   *  Returns the word only — compose with `t` if you need number prefixes. */
  tp: (base: string, n: number) => string;
};

const LanguageContext = createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s === "en" || s === "ru") setLocale(s);
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale, hydrated]);

  const value = useMemo<Ctx>(() => {
    const t = (key: string, vars?: Record<string, string | number>) => {
      const s = STRINGS[locale][key] ?? STRINGS.en[key] ?? key;
      return format(s, vars);
    };
    const tp = (base: string, n: number) => {
      const k = pluralKey(locale, n);
      // Fall back to .other if a specific form is missing.
      const candidate =
        STRINGS[locale][`${base}.${k}`] ?? STRINGS[locale][`${base}.other`];
      return candidate ?? STRINGS.en[`${base}.other`] ?? base;
    };
    return { locale, setLocale, t, tp };
  }, [locale]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useT(): Ctx {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useT must be used within LanguageProvider");
  return ctx;
}
