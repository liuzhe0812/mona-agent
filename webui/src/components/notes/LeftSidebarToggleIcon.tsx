interface LeftSidebarToggleIconProps {
  open: boolean;
  className?: string;
}

export function LeftSidebarToggleIcon({ open, className }: LeftSidebarToggleIconProps) {
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
      {open && <rect x="3" y="4" width="4" height="16" fill="currentColor" stroke="none" />}
      <line x1="7" y1="4" x2="7" y2="20" />
    </svg>
  );
}
