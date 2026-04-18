import { useEffect, useState } from "react";

export function useObsidianDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => document.body.classList.contains("theme-dark"));

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.body.classList.contains("theme-dark"));
    });

    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
