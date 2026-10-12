import { useCallback, useState } from "react";
import type { ToastItem } from "../components/Toast";

export type LogItem = { t: string; hl?: boolean };

/**
 * 提示系统：事件日志（面板里倒序显示）+ 浮动 toast。
 *
 * 为什么单独抽出来：App.tsx 原本有 49 个 useState、1691 行，其中提示相关的
 * 状态与回调散落各处（两套状态 + 两个 useCallback），每次改动都要在
 * 1700 行里找到对应位置。这块逻辑自成一体、没有任何链上依赖，是最安全的切分点。
 *
 * 行为约定（与抽取前完全一致，避免"重构顺手改行为"）：
 *   - 日志最多保留 40 条，新的在最前
 *   - toast 4.5 秒后自动消失，可手动关闭
 */
export function useToasts() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const log = useCallback((t: string, hl?: boolean) => {
    setLogs((prev) => [{ t, hl }, ...prev].slice(0, 40));
  }, []);

  const toast = useCallback((title: string, body?: string, kind?: "slash" | "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((p) => [...p, { id, title, body, kind }]);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((p) => p.filter((x) => x.id !== id));
  }, []);

  return { logs, toasts, log, toast, dismissToast };
}
