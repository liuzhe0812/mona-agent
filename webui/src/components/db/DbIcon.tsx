import { cn } from "@/lib/utils";

export const dbIconNames = [
  "connection",
  "database",
  "table",
  "view",
  "procedure",
  "query",
  "refresh",
  "add",
  "remove",
  "save",
  "undo",
  "columns",
  "structure",
  "index",
  "ddl",
  "filter",
  "sort",
  "sortAsc",
  "sortDesc",
  "close",
  "chevronLeft",
  "chevronRight",
  "search",
  "copy",
  "play",
  "code",
  "pin",
] as const;

export type DbIconName = (typeof dbIconNames)[number];

export interface DbIconProps {
  name: DbIconName;
  className?: string;
}

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Cylinder({ connected }: { connected?: boolean }) {
  return (
    <g className="text-info">
      <ellipse cx="8" cy="4.5" rx="4.5" ry="2" fill="currentColor" fillOpacity="0.14" />
      <path d="M3.5 4.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7" fill="currentColor" fillOpacity="0.08" />
      <path d="M3.5 4.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" />
      <path d="M3.5 11.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" />
      {connected && (
        <path d="M12.5 8.5h2.25a1.25 1.25 0 0 1 1.25 1.25v1.5m-3.5-2.75V7m3.5 4.25v1.25a1.25 1.25 0 0 1-1.25 1.25H13" />
      )}
      {connected && <path d="M10.5 13.75h2.5v2.5h2.5" />}
    </g>
  );
}

function TableShape({
  withEye,
  domainColor = true,
}: {
  withEye?: boolean;
  domainColor?: boolean;
}) {
  return (
    <g className={domainColor ? "text-info" : undefined}>
      <rect x={withEye ? 1.5 : 2} y="3" width={withEye ? 10 : 16} height="14" rx="1" fill="currentColor" fillOpacity="0.06" />
      <path d={withEye ? "M2 6h9" : "M2.5 6h15"} fill="currentColor" fillOpacity="0.18" />
      <path d={withEye ? "M2 6h9" : "M2.5 6h15"} />
      <path d={withEye ? "M2 10h9M2 13.5h9M5.5 6v10M8.5 6v10" : "M2.5 10h15M2.5 13.5h15M6 6v11M11 6v11M15 6v11"} />
      {withEye && (
        <>
          <path d="M12.5 11s1.3-2.5 3.5-2.5 3.5 2.5 3.5 2.5-1.3 2.5-3.5 2.5-3.5-2.5-3.5-2.5Z" fill="currentColor" fillOpacity="0.08" />
          <circle cx="16" cy="11" r="0.9" fill="currentColor" stroke="none" />
        </>
      )}
    </g>
  );
}

function IconShape({ name }: { name: DbIconName }) {
  switch (name) {
    case "connection":
      return <Cylinder connected />;
    case "database":
      return (
        <g className="text-success">
          <ellipse cx="10" cy="4.5" rx="6" ry="2.5" fill="currentColor" fillOpacity="0.14" />
          <path d="M4 4.5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-10" fill="currentColor" fillOpacity="0.08" />
          <path d="M4 4.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5M4 9.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5M4 14.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
        </g>
      );
    case "table":
      return <TableShape />;
    case "view":
      return <TableShape withEye />;
    case "procedure":
      return (
        <g className="text-warning">
          <path d="M3 6h3l-2 8h3M5 10h3" />
          <path d="m10 9 5 5m0-5-5 5" />
        </g>
      );
    case "query":
      return (
        <g>
          <path d="M3 3.5h10l4 4v9H3z" />
          <path d="M13 3.5v4h4M6 10l2 2-2 2m4-1h3" />
        </g>
      );
    case "refresh":
      return <path d="M16 7.5A6 6 0 1 0 17 12M16 4v3.5h-3.5" />;
    case "add":
      return <path d="M10 4v12M4 10h12" />;
    case "remove":
      return <path d="M4 10h12" />;
    case "save":
      return (
        <g>
          <path d="M4 3.5h10l2 2v11H4z" />
          <path d="M7 3.5v4h6v-4M7 16.5v-4h6v4" />
        </g>
      );
    case "undo":
      return <path d="M7 6 3.5 9.5 7 13M4 9.5h7a5 5 0 0 1 5 5" />;
    case "columns":
      return <TableShape withEye domainColor={false} />;
    case "structure":
      return (
        <g>
          <rect x="2" y="3" width="10" height="13.5" rx="1" fill="currentColor" fillOpacity="0.06" />
          <path d="M2 6h10" fill="currentColor" fillOpacity="0.18" />
          <path d="M2 6h10M2 9.5h10M2 13h10M5.5 6v10.5M8.75 6v10.5" />
          <path d="m11 14.5 4.75-4.75 1.75 1.75L12.75 15H11z" fill="currentColor" fillOpacity="0.14" />
          <path d="m11 14.5 4.75-4.75 1.75 1.75L12.75 15H11z" />
        </g>
      );
    case "index":
      return (
        <g>
          <circle cx="4.5" cy="7.5" r="2.25" />
          <path d="M6.75 7.5H17M9.75 7.5v2M12.5 7.5v2" />
          <path d="M10 12h7M10 14.75h5M10 17.5h3" />
        </g>
      );
    case "ddl":
      return (
        <g>
          <path d="M3 3.5h10l4 4v9H3zM13 3.5v4h4" />
          <text x="4" y="14" fill="currentColor" stroke="none" fontSize="5.5" fontWeight="700" letterSpacing="0.4">DDL</text>
        </g>
      );
    case "filter":
      return <path d="M3 4h14l-5.5 6v5l-3 1v-6z" />;
    case "sort":
      return (
        <g>
          <path d="M6 15V5m0 0L3.5 7.5M6 5l2.5 2.5M14 5v10m0 0-2.5-2.5M14 15l2.5-2.5" />
        </g>
      );
    case "sortAsc":
      return <path d="M10 16V4m0 0L6 8m4-4 4 4" />;
    case "sortDesc":
      return <path d="M10 4v12m0 0-4-4m4 4 4-4" />;
    case "close":
      return <path d="m5 5 10 10M15 5 5 15" />;
    case "chevronLeft":
      return <path d="m12.5 4.5-5 5.5 5 5.5" />;
    case "chevronRight":
      return <path d="m7.5 4.5 5 5.5-5 5.5" />;
    case "search":
      return <path d="m13.5 13.5 3.5 3.5M8.75 14.5a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5Z" />;
    case "copy":
      return (
        <g>
          <rect x="6.5" y="6.5" width="9" height="10" rx="1" />
          <path d="M13.5 6.5V4.75a1.25 1.25 0 0 0-1.25-1.25h-7A1.25 1.25 0 0 0 4 4.75v8.5a1.25 1.25 0 0 0 1.25 1.25H6.5" />
        </g>
      );
    case "play":
      return <path d="m6 4 10 6-10 6z" fill="currentColor" fillOpacity="0.14" />;
    case "code":
      return <path d="m7.5 6-4 4 4 4M12.5 6l4 4-4 4M11 4.5 9 15.5" />;
    case "pin":
      return (
        <g>
          <path d="m7 3 6 2-1 4 2.5 2.5-1.5 1.5-3-2-2.5 6-.75-.75 2-6.5L5.5 8z" fill="currentColor" fillOpacity="0.1" />
          <path d="m7 3 6 2-1 4 2.5 2.5-1.5 1.5-3-2-2.5 6-.75-.75 2-6.5L5.5 8z" />
        </g>
      );
  }
}

export function DbIcon({ name, className }: DbIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn("h-4 w-4 shrink-0", className)}
      focusable="false"
      height="20"
      viewBox="0 0 20 20"
      width="20"
      xmlns="http://www.w3.org/2000/svg"
      {...strokeProps}
    >
      <IconShape name={name} />
    </svg>
  );
}
