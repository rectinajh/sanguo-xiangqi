import { useEffect, useState } from "react";
import type { SpikeFrame } from "@sanguo/shared";

/** Hold drama high while thinking so multi-path current stays continuous. */
export function useSpikePlayback(frame: SpikeFrame | null, thinking: boolean) {
  const [displayRates, setDisplayRates] = useState<number[] | null>(null);
  const [drama, setDrama] = useState(0);

  useEffect(() => {
    if (!frame) {
      setDisplayRates(null);
      setDrama(0);
      return;
    }
    setDisplayRates(frame.rates);
    if (thinking) {
      setDrama(1);
      return;
    }
    setDrama(0.85);
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / 1800);
      // Floor a little longer so waves finish a cycle
      setDrama(0.85 * (1 - u));
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, thinking]);

  return { displayRates, drama };
}
