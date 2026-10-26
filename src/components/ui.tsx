import React from "react";

export function Block({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-divider/80 bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function BlockPad({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function BlockHeader({
  kicker,
  title,
  sub,
  right,
}: {
  kicker?: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {kicker && (
          <div className="inline-flex items-center gap-2 rounded-full bg-tag px-2.5 py-1 text-[11px] font-medium text-mention mb-2">
            {kicker}
          </div>
        )}
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {sub && <p className="text-[13px] text-mention mt-0.5">{sub}</p>}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-mention/60">
      {children}
    </div>
  );
}

export function ToolButton({
  title,
  onClick,
  active = false,
  danger = false,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`p-2 rounded-lg transition border border-transparent ${
        active
          ? "bg-action text-white hover:bg-action-hover"
          : danger
          ? "text-mention hover:bg-tag hover:text-ink"
          : "text-mention hover:bg-tag hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-xl bg-action px-4 py-2 text-[13px] font-medium text-white hover:bg-action-hover disabled:opacity-40 transition"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-xl border border-divider bg-white px-3 py-2 text-xs font-medium text-mention hover:bg-canvas hover:text-ink disabled:opacity-40 transition"
    >
      {children}
    </button>
  );
}

export function EmptyState({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-divider bg-canvas/60 p-8 text-center space-y-2">
      <div className="text-sm font-medium text-ink">{title}</div>
      {sub && <p className="text-xs text-mention max-w-md mx-auto">{sub}</p>}
      {action && <div className="pt-2 flex justify-center">{action}</div>}
    </div>
  );
}


