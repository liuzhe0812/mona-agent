import { cn } from "@/lib/utils";

export const dbIconNames = [
  "connection",
  "mysql",
  "sqlite",
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
  "list",
  "grid",
  "eye",
  "eyeOff",
  "newTable",
  "refreshTable",
  "rename",
  "dropTable",
  "highlight",
  "paste",
  "jump",
  "selectAll",
  "lockColumn",
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
      <ellipse cx="8" cy="4.5" rx="5.25" ry="2.35" fill="currentColor" fillOpacity="0.9" stroke="none" />
      <path d="M2.75 4.5v8.5c0 1.3 2.35 2.35 5.25 2.35S13.25 14.3 13.25 13V4.5" fill="currentColor" fillOpacity="0.82" stroke="none" />
      <path d="M2.75 8.25c0 1.3 2.35 2.35 5.25 2.35s5.25-1.05 5.25-2.35M2.75 12c0 1.3 2.35 2.35 5.25 2.35S13.25 13.3 13.25 12" stroke="hsl(var(--background))" strokeWidth="1.15" />
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
    <g className={domainColor ? undefined : "text-foreground"}>
      <rect x={withEye ? 1.5 : 2} y="3" width={withEye ? 11.5 : 16} height="14" rx="0.75"
        fill={domainColor ? "hsl(var(--background))" : "currentColor"} fillOpacity={domainColor ? 1 : 0.06}
        stroke={domainColor ? "hsl(var(--muted-foreground))" : "currentColor"} />
      {domainColor && <rect x={withEye ? 1.5 : 2} y="3" width={withEye ? 11.5 : 16} height="3.6" rx="0.75" fill="hsl(var(--db-table-icon))" stroke="none" />}
      <path d={withEye ? "M2 6.6h11" : "M2.5 6.6h15"} />
      <path d={withEye ? "M2 10h11M2 13.5h11M5.75 6.6v10M9.5 6.6v10" : "M2.5 10h15M2.5 13.5h15M6.25 6.6v10.4M10.25 6.6v10.4M14.25 6.6v10.4"}
        stroke={domainColor ? "hsl(var(--muted-foreground))" : "currentColor"} strokeWidth={domainColor ? 0.8 : 1.5} />
      {withEye && (
        <>
          <path d="M11.5 12s1.5-2.8 4-2.8 4 2.8 4 2.8-1.5 2.8-4 2.8-4-2.8-4-2.8Z" fill="hsl(var(--info-strong))" fillOpacity="0.12" stroke="hsl(var(--info-strong))" />
          <circle cx="15.5" cy="12" r="1" fill="hsl(var(--info-strong))" stroke="none" />
        </>
      )}
    </g>
  );
}

function IconShape({ name }: { name: DbIconName }) {
  switch (name) {
    case "connection":
      return <Cylinder connected />;
    case "mysql":
      return (
        <g data-symbol="mysql-dolphin">
          <rect x="1.25" y="1.25" width="17.5" height="17.5" rx="3" fill="hsl(var(--info-strong))" stroke="none" />
          <path
            d="M3.7 11.2c1.55-3.75 4.75-5.7 8.25-4.85 1.05.25 1.95.72 2.68 1.4l2.38-.18-1.55 1.38c.66.64 1.04 1.43 1.12 2.34-1.18-.55-2.35-.7-3.5-.42-1.3.32-2.25 1.12-2.83 2.39 1.35.68 2.16 1.64 2.43 2.88-1.27-.93-2.54-1.3-3.81-1.12L7.5 16.8l-.14-2.04c-1.2-.4-2.1-1.12-2.72-2.15l-1.9.35.96-1.76Z"
            fill="hsl(var(--primary-foreground))"
            stroke="none"
          />
          <circle cx="12.55" cy="7.67" r="0.48" fill="hsl(var(--info-strong))" stroke="none" />
        </g>
      );
    case "sqlite":
      return (
        <g data-symbol="sqlite-database" className="text-info">
          <path d="M4 2.5h8l4 4v11H4z" fill="currentColor" fillOpacity="0.12" />
          <path d="M12 2.5v4h4" />
          <ellipse cx="8.25" cy="10" rx="2.75" ry="1.25" fill="currentColor" fillOpacity="0.45" />
          <path d="M5.5 10v4c0 .7 1.25 1.25 2.75 1.25S11 14.7 11 14v-4M5.5 12c0 .7 1.25 1.25 2.75 1.25S11 12.7 11 12" />
        </g>
      );
    case "database":
      return (
        <g style={{ color: "hsl(var(--db-object-icon))" }}>
          <ellipse cx="10" cy="4.25" rx="7.25" ry="3.1" fill="currentColor" fillOpacity="0.92" stroke="none" />
          <path d="M2.75 4.25v10.5c0 1.7 3.25 3.1 7.25 3.1s7.25-1.4 7.25-3.1V4.25" fill="currentColor" fillOpacity="0.86" stroke="none" />
          <path d="M2.75 8.9C2.75 10.6 6 12 10 12s7.25-1.4 7.25-3.1M2.75 13.05c0 1.7 3.25 3.1 7.25 3.1s7.25-1.4 7.25-3.1" stroke="hsl(var(--background))" strokeWidth="1.35" />
        </g>
      );
    case "table":
      return <TableShape />;
    case "view":
      return <TableShape withEye />;
    case "procedure":
      return (
        <g>
          <rect x="2" y="2" width="16" height="16" rx="1.25" fill="hsl(var(--db-procedure-icon))" stroke="none" />
          <text x="3.1" y="13.6" fill="hsl(var(--background))" stroke="none" fontSize="10" fontFamily="serif" fontStyle="italic">fx</text>
        </g>
      );
    case "query":
      return (
        <g>
          <path d="M15 7V3H2v13h5M2 6h13M5 9h3M5 12h2" />
          <circle cx="12" cy="12" r="3.5" /><path d="m14.5 14.5 3 3" />
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
    case "highlight":
      return (
        <g>
          <path d="M10 3a7 7 0 1 0 0 14h1.2a1.4 1.4 0 0 0 1.15-2.2l-.45-.65a1.35 1.35 0 0 1 1.1-2.15h1.5A2.5 2.5 0 0 0 17 9.5 7 7 0 0 0 10 3Z" />
          <circle cx="6.5" cy="8" r=".8" fill="currentColor" stroke="none" />
          <circle cx="9" cy="6" r=".8" fill="currentColor" stroke="none" />
          <circle cx="12" cy="6.7" r=".8" fill="currentColor" stroke="none" />
        </g>
      );
    case "paste":
      return <g><rect x="4" y="5" width="12" height="12" rx="1" /><path d="M7 5V3.5h6V5M7 9h6M7 12h6" /></g>;
    case "jump":
      return <path d="M4 15V8a3 3 0 0 1 3-3h8m-3-3 3 3-3 3M9 12l3 3-3 3" />;
    case "selectAll":
      return <g><path d="M6 3H3v3M14 3h3v3M17 14v3h-3M6 17H3v-3" /><rect x="6.5" y="6.5" width="7" height="7" rx=".5" /></g>;
    case "lockColumn":
      return <g><path d="M2.5 4h15v12h-15zM7.5 4v12M12.5 4v4" /><rect x="11" y="11" width="7" height="6" rx="1" /><path d="M12.5 11V9.5a2 2 0 0 1 4 0V11" /></g>;
    case "list":
      return <g><path d="M7 5h10M7 10h10M7 15h10" /><path d="M3 4h1v2H3zM3 9h1v2H3zM3 14h1v2H3z" fill="currentColor" /></g>;
    case "grid":
      return <g><rect x="3" y="3" width="5" height="5" rx=".5" /><rect x="12" y="3" width="5" height="5" rx=".5" /><rect x="3" y="12" width="5" height="5" rx=".5" /><rect x="12" y="12" width="5" height="5" rx=".5" /></g>;
    case "eye":
      return <g><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" /><circle cx="10" cy="10" r="2.5" /></g>;
    case "eyeOff":
      return <g><path d="m3 3 14 14M6 5.8C3.5 7.2 2 10 2 10s3 5 8 5c1.5 0 2.8-.4 4-1.1M9 5c5.5-.7 9 5 9 5s-.7 1.3-2 2.5" /></g>;
    case "newTable":
      return <g><path d="M17 8V3H2v13h6M2 7h15M2 11h7M7 7v9M12 7v2M14 10v8M10 14h8" /></g>;
    case "refreshTable":
      return <g><path d="M17 7V3H2v13h6M2 7h15M2 11h6M7 7v9M12 7v1M17 12a4 4 0 1 0 1 3M17 9v3h-3" /></g>;
    case "rename":
      return <g><path d="M9 5H2v10h7M15 5h3v10h-3M10 3h4m-2 0v14m-2 0h4M5 8v4m0-4h2v4" /></g>;
    case "dropTable":
      return <g><path d="M17 7V3H2v13h5M2 7h15M2 11h7M7 7v9M11 10l7 7m0-7-7 7" /></g>;
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
