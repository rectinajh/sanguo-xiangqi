import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpikeFrame } from "@sanguo/shared";
import { ConnectomeScene } from "./ConnectomeScene";
import { buildNeighborSet } from "./neighborGraph";
import { searchNeurons, type SearchHit } from "./neuronSearch";

type NeuronMeta = { id: number; nt?: string; type?: string };
type Synapse = { pre: number; post: number; weight: number };

export function NeuronBrowser({
  frame,
  thinking,
  onClose,
}: {
  frame: SpikeFrame | null;
  thinking: boolean;
  onClose: () => void;
}) {
  const [neurons, setNeurons] = useState<NeuronMeta[]>([]);
  const [synapses, setSynapses] = useState<Synapse[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetch("/cyberfly/subnet.json").then((r) => r.json());
        if (!cancelled) {
          setNeurons(s.neurons ?? []);
          setSynapses(s.synapses ?? []);
        }
      } catch {
        /* soft-fail */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setHits(searchNeurons(neurons, query).slice(0, 40));
  }, [neurons, query]);

  const neighbor = useMemo(() => {
    if (selectedId == null || !synapses.length) return null;
    return buildNeighborSet(synapses, selectedId, 1);
  }, [selectedId, synapses]);

  const selectedMeta = useMemo(
    () => (selectedId == null ? null : neurons.find((n) => n.id === selectedId) ?? null),
    [neurons, selectedId]
  );

  const selectedRate = useMemo(() => {
    if (selectedId == null || !frame) return null;
    const idx = frame.neuronIds.indexOf(selectedId);
    if (idx < 0) return null;
    return frame.rates[idx] ?? null;
  }, [frame, selectedId]);

  const onSelect = useCallback((id: number | null) => setSelectedId(id), []);

  return (
    <div className="neuron-browser" role="dialog" aria-modal="true" aria-label="神经元浏览器">
      <div className="neuron-browser-bar">
        <h2>神经元浏览器</h2>
        <input
          className="neuron-browser-search"
          type="search"
          placeholder="搜索 bodyId / type / nt…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button type="button" className="ghost" onClick={onClose}>
          返回对局
        </button>
      </div>
      <div className="neuron-browser-body">
        <div className="neuron-browser-canvas">
          <ConnectomeScene
            frame={frame}
            thinking={thinking}
            selectedId={selectedId}
            onSelect={onSelect}
            focusNeighborIds={neighbor?.nodeIds ?? null}
            focusEdgeIndices={neighbor?.edgeIndices ?? null}
            interactive
            autoSpin={false}
          />
        </div>
        <aside className="neuron-browser-side">
          <section>
            <h3>搜索结果</h3>
            {hits.length === 0 ? (
              <p className="neuron-browser-empty">
                {query.trim() ? "无匹配" : "输入 bodyId 或 type"}
              </p>
            ) : (
              <ul className="neuron-browser-hits">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className={h.id === selectedId ? "on" : ""}
                      onClick={() => setSelectedId(h.id)}
                    >
                      <strong>{h.id}</strong>
                      <span>
                        {h.type ?? "—"} · {h.nt ?? "—"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>选中详情</h3>
            {selectedMeta ? (
              <dl className="neuron-browser-detail">
                <div>
                  <dt>bodyId</dt>
                  <dd>{selectedMeta.id}</dd>
                </div>
                <div>
                  <dt>type</dt>
                  <dd>{selectedMeta.type ?? "—"}</dd>
                </div>
                <div>
                  <dt>nt</dt>
                  <dd>{selectedMeta.nt ?? "—"}</dd>
                </div>
                <div>
                  <dt>rate</dt>
                  <dd>{selectedRate == null ? "—" : selectedRate.toFixed(3)}</dd>
                </div>
                <div>
                  <dt>邻居</dt>
                  <dd>{neighbor ? neighbor.nodeIds.size - 1 : 0}（1-hop）</dd>
                </div>
              </dl>
            ) : (
              <p className="neuron-browser-empty">点击场景中的神经元，或从搜索结果选择</p>
            )}
          </section>
          <p className="cyberfly-disclaimer">
            连接组动力学推断 · 非果蝇真实思维 · MaleCNS CC-BY · Esc 返回
          </p>
        </aside>
      </div>
    </div>
  );
}