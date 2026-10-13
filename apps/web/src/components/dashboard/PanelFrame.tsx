import type { ReactNode } from "react";

export function PanelFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="panel" aria-labelledby="panel-title">
      <header className="panel-head">
        <h1 id="panel-title">{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="error" role="alert">
      {message}
    </div>
  );
}
