import { useState } from "react";
import type { SpikeFrame } from "@sanguo/shared";
import { ConnectomeScene } from "./ConnectomeScene";
import { NeuronBrowser } from "./NeuronBrowser";
import { populationColor } from "./populationColor";

export function CyberflyBrainPanel({
  frame,
  thinking,
}: {
  frame: SpikeFrame | null;
  thinking: boolean;
}) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const drives = frame?.drives ?? { aggression: 0, avoidance: 0, courtship: 0 };
  return (
    <>
      <div className="panel cyberfly-panel">
        <div className="cyberfly-head">
          <h2 style={{ margin: 0 }}>果蝇大脑 AI 决策</h2>
          <span className={`cyberfly-badge ${thinking ? "on" : ""}`}>
            {thinking ? "思考放电中" : "旁观"}
          </span>
        </div>
        <div className="cyberfly-canvas-wrap">
          <ConnectomeScene frame={frame} thinking={thinking} />
        </div>
        <div className="cyberfly-legend">
          {(["P1", "DN", "GABA", "other"] as const).map((g) => (
            <span key={g} className="cyberfly-legend-item">
              <i style={{ background: populationColor(g) }} />
              {g}
            </span>
          ))}
        </div>
        <div className="cyberfly-drives">
          {(
            [
              ["攻击", drives.aggression],
              ["回避", drives.avoidance],
              ["求偶", drives.courtship],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="cyberfly-drive">
              <span>{label}</span>
              <div className="cyberfly-drive-bar">
                <div style={{ width: `${Math.round(v * 100)}%` }} />
              </div>
              <em>{v.toFixed(2)}</em>
            </div>
          ))}
        </div>
        <p className="cyberfly-disclaimer">
          连接组动力学推断 · 非果蝇真实思维 · MaleCNS CC-BY
        </p>
        <button
          type="button"
          className="ghost cyberfly-browser-btn"
          onClick={() => setBrowserOpen(true)}
        >
          打开神经元浏览器
        </button>
      </div>
      {browserOpen ? (
        <NeuronBrowser
          frame={frame}
          thinking={thinking}
          onClose={() => setBrowserOpen(false)}
        />
      ) : null}
    </>
  );
}
