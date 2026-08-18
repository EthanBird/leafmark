import type { ReactNode } from "react";

export function ViewerLoading({ label }: { label: string }) {
  return <div className="viewer-loading" role="status"><span /><strong>{label}</strong><small>解析在独立线程中进行，窗口立刻可操作</small></div>;
}

export function ViewerMessage({ icon, title, message, action }: { icon: ReactNode; title: string; message: string; action?: ReactNode }) {
  return <div className="viewer-message">{icon}<h2>{title}</h2><p>{message}</p>{action}</div>;
}
