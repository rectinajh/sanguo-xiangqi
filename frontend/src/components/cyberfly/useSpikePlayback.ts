import { useEffect, useState } from "react";
import type { SpikeFrame } from "@sanguo/shared";

/** Ease spike intensities for drama: hold while thinking, then decay afterglow. */
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
    setDrama(thinking ? 1 : 0.7);
    if (!thinking) {
      const t0 = performance.now();
      let raf = 0;
      const tick = (now: number) => {
        // ~1.6s afterglow so traveling pulses remain readable after the move commits
        const u = Math.min(1, (now - t0) / 1600);
        setDrama(0.7 * (1 - u));
        if (u < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
  }, [frame, thinking]);

  return { displayRates, drama };
}
