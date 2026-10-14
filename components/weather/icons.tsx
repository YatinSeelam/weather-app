import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function MapPinIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 14.5s4.5-4.1 4.5-7.75a4.5 4.5 0 1 0-9 0C3.5 10.4 8 14.5 8 14.5Z" />
      <circle cx="8" cy="6.75" r="1.6" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 1.75 2.75 3.6v4.1c0 3.05 2.1 5.4 5.25 6.55 3.15-1.15 5.25-3.5 5.25-6.55V3.6L8 1.75Z" />
    </svg>
  );
}

export function GaugeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
      <path d="m8 11.5 2.5-3.5" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={`animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
