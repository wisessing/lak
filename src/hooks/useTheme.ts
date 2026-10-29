import { useCallback, useEffect, useState } from 'react';

/**
 * Theme, stamped on `<html data-theme>` and persisted.
 *
 * Dark is the default; "grey" swaps the viewport ground for an 18% reference
 * grey. The initial value is applied by an inline script in index.html before
 * first paint — this hook adopts whatever that decided rather than re-deciding,
 * so there is no flash and no second source of truth.
 */

export type Theme = 'dark' | 'grey';

const STORAGE_KEY = 'lak.theme';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'grey' ? 'grey' : 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private mode or blocked storage: the theme still applies for this
      // session, it just will not be remembered.
    }
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'dark' ? 'grey' : 'dark')),
    []
  );

  return { theme, setTheme, toggleTheme };
}
