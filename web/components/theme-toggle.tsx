"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "agentrail-theme";

/**
 * Runs before paint (inlined in the document head): the stored choice, or `?theme=` in the URL,
 * else dark. Kept as a string so it can be inlined; no React, no hydration gap.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q==="light"||q==="dark"?q:localStorage.getItem(${JSON.stringify(THEME_KEY)});if(q)localStorage.setItem(${JSON.stringify(THEME_KEY)},q);document.documentElement.dataset.theme=t==="light"?"light":"dark";}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    setTheme(next);
  };
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === "dark" ? "switch to light theme" : "switch to dark theme"}
      title={theme === "dark" ? "light theme" : "dark theme"}
      className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-muted hover:border-border-strong hover:text-ink"
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
