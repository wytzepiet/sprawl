import type { JSX } from "solid-js";

interface IconProps {
  size?: number;
  "stroke-width"?: number;
}

function Icon(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props["stroke-width"] ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

export function CarOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 2a2 2 0 0 1 2 2v4h-2V4h-4v2H8V4a2 2 0 0 1 2-2z" />
      <rect x="3" y="10" width="18" height="8" rx="2" />
      <circle cx="7" cy="22" r="2" />
      <circle cx="17" cy="22" r="2" />
      <line x1="2" y1="2" x2="22" y2="22" stroke-width="2" />
    </Icon>
  );
}

export function RotateCcw(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Icon>
  );
}
