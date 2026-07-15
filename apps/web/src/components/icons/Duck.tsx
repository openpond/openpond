import type { SVGProps } from "react";

export function Duck({
  className,
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      aria-hidden="true"
      className={["duck-icon", className].filter(Boolean).join(" ")}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <path d="M4 15.5A5.5 5.5 0 0 1 9.5 10H12V8a4 4 0 0 1 8 0v1h2l-2.3 2.1c-.7.6-1.5.9-2.4.9H16c.8 1 1.2 2.2 1.2 3.5A4.5 4.5 0 0 1 12.7 20H8.5A4.5 4.5 0 0 1 4 15.5Z" />
      <circle cx="17" cy="7.5" fill="currentColor" r=".75" stroke="none" />
    </svg>
  );
}
