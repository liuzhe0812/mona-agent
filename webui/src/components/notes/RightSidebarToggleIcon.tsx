interface RightSidebarToggleIconProps {
  open: boolean;
  className?: string;
}

export function RightSidebarToggleIcon({ open, className }: RightSidebarToggleIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {open && <rect x="17" y="4" width="4" height="16" fill="currentColor" stroke="none" />}
      <line x1="17" y1="4" x2="17" y2="20" />
    </svg>
  );
}
