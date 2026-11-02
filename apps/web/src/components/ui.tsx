import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { initials } from '../lib/format';

/** Peças visuais compartilhadas entre o chat do funcionário e o console do analista. */

export const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

export function LogoMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M4 3h3.6l8.8 11.2V3H20v18h-3.6L7.6 9.8V21H4z" />
    </svg>
  );
}

export function Logo({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight', tone === 'light' ? 'text-white' : 'text-ink')}>
      <LogoMark className={cx('size-5', tone === 'light' ? 'text-white' : 'text-brand')} />
      Nexo Assist
    </span>
  );
}

const AVATAR_TONES = ['bg-sky-100 text-sky-800', 'bg-rose-100 text-rose-800', 'bg-violet-100 text-violet-800', 'bg-emerald-100 text-emerald-800', 'bg-amber-100 text-amber-800', 'bg-slate-200 text-slate-700'];

export function Avatar({ name, size = 'md', online }: { name: string; size?: 'sm' | 'md'; online?: boolean }) {
  const tone = AVATAR_TONES[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold', size === 'sm' ? 'size-8 text-xs' : 'size-10 text-sm', tone)} aria-hidden>
      {initials(name)}
      {online ? <span className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-white bg-emerald-500" /> : null}
    </span>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong disabled:bg-brand/50',
  secondary: 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-60',
};

export function Button({ variant = 'secondary', className, busy, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className = 'size-3.5' }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function Banner({ tone = 'info', children, action }: { tone?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode; action?: ReactNode }) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm', tones[tone])}>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Ponto colorido + rótulo (status, prioridade). */
export function Dot({ tone, children, className }: { tone: string; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', tone)} />
      {children}
    </span>
  );
}

export function Pill({ tone, children }: { tone: 'green' | 'amber' | 'blue' | 'slate' | 'rose'; children: ReactNode }) {
  const tones = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    blue: 'border-sky-200 bg-sky-50 text-sky-800',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  const dots = { green: 'bg-emerald-500', amber: 'bg-amber-500', blue: 'bg-sky-500', slate: 'bg-slate-400', rose: 'bg-rose-500' };
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone])}>
      <span aria-hidden className={cx('size-1.5 rounded-full', dots[tone])} />
      {children}
    </span>
  );
}

type IconProps = SVGProps<SVGSVGElement>;
const base = (props: IconProps) => ({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: 'size-4', ...props });

export const Icons = {
  chat: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M4 5h16v11H8l-4 4z" />
    </svg>
  ),
  user: (p: IconProps) => (
    <svg {...base(p)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </svg>
  ),
  logout: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
    </svg>
  ),
  send: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  check: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M5 12l4 4 10-10" />
    </svg>
  ),
  x: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  alert: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M12 4l9 16H3zM12 10v4M12 17v.5" />
    </svg>
  ),
  headset: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M4 14v-2a8 8 0 0116 0v2M4 14h3v5H4zM17 14h3v5h-3z" />
    </svg>
  ),
  transfer: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M4 8h14l-3-3M20 16H6l3 3" />
    </svg>
  ),
  search: (p: IconProps) => (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4-4" />
    </svg>
  ),
  plus: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  menu: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  back: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  mail: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M3 6h18v12H3zM3 7l9 6 9-6" />
    </svg>
  ),
  lock: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M6 11h12v9H6zM8 11V8a4 4 0 018 0v3" />
    </svg>
  ),
  eye: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  info: (p: IconProps) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.5" />
    </svg>
  ),
  tickets: (p: IconProps) => (
    <svg {...base(p)}>
      <path d="M4 6h16v4a2 2 0 000 4v4H4v-4a2 2 0 000-4z" />
    </svg>
  ),
};
