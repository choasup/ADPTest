import { useEffect, useState } from 'react';

/** 视口是否窄于 900px —— 进入单栏模式。 */
export function useNarrow(breakpoint = 900): boolean {
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    const onResize = () => {
      const next = window.innerWidth < breakpoint;
      setNarrow((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);

  return narrow;
}
