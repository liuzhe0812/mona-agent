import { cn } from "@/lib/utils";

const colors = [
  "hsl(var(--data-1))",
  "hsl(var(--data-2))",
  "hsl(var(--data-3))",
  "hsl(var(--data-4))",
  "hsl(var(--data-5))",
  "hsl(var(--data-6))",
  "hsl(var(--info))",
  "hsl(var(--ai-cyan))",
];

function hashId(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

function RadialPetals({
  d,
  count = 4,
  fill,
}: {
  d: string;
  count?: number;
  fill: string;
}) {
  return (
    <g fill={fill}>
      {Array.from({ length: count }, (_, index) => (
        <path key={index} d={d} transform={`rotate(${(360 * index) / count} 12 12)`} />
      ))}
    </g>
  );
}

export function SubagentAvatar({ id, className }: { id: string; className?: string }) {
  const hash = hashId(id);
  const colorIndex = hash % colors.length;
  const primary = colors[colorIndex];
  const secondary = primary;

  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5 shrink-0", className)}
      fillOpacity={0.75}
      stroke="hsl(var(--background))"
      strokeWidth={0.5}
      aria-hidden="true"
      focusable="false"
    >
      {hash % 8 === 0 && (
        <>
          <RadialPetals d="M12 11.4C8.9 9.1 9.4 5.4 12 2.5c2.6 2.9 3.1 6.6 0 8.9Z" fill={primary} />
          <circle cx="12" cy="12" r="2.1" fill={secondary} />
        </>
      )}
      {hash % 8 === 1 && (
        <>
          <RadialPetals d="M12 12 3.1 7.2c4.8-1.7 8.9-.2 8.9 4.8Z" fill={primary} />
          <circle cx="12" cy="12" r="2.1" fill={secondary} />
        </>
      )}
      {hash % 8 === 2 && (
        <>
          <RadialPetals d="M12 1.7 15.7 8.1 12 12l-3.7-3.9Z" fill={primary} />
          <path d="m12 8.7 3.3 3.3-3.3 3.3L8.7 12Z" fill={secondary} />
        </>
      )}
      {hash % 8 === 3 && (
        <>
          <RadialPetals count={8} d="M12 11.7c-2.5-2.4-1.3-6.2 0-9.2 1.3 3 2.5 6.8 0 9.2Z" fill={primary} />
          <circle cx="12" cy="12" r="1.8" fill={secondary} />
        </>
      )}
      {hash % 8 === 4 && (
        <>
          <path
            d="M12 2.3a9.7 9.7 0 1 0 0 19.4 9.7 9.7 0 0 0 0-19.4Zm0 4.1a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2Z"
            fill={primary}
            fillRule="evenodd"
          />
          <RadialPetals d="M12 3.2 13.3 6.7 12 8l-1.3-1.3Z" fill={secondary} />
        </>
      )}
      {hash % 8 === 5 && (
        <>
          <g fill={primary}>
            <circle cx="12" cy="6.4" r="4.2" />
            <circle cx="17.6" cy="12" r="4.2" />
            <circle cx="12" cy="17.6" r="4.2" />
            <circle cx="6.4" cy="12" r="4.2" />
          </g>
          <path d="m12 8.8 3.2 3.2-3.2 3.2L8.8 12Z" fill={secondary} />
        </>
      )}
      {hash % 8 === 6 && (
        <>
          <path d="M12 1.7 22.3 12 12 22.3 1.7 12Z" fill={primary} />
          <path d="m12 6.1 5.9 5.9-5.9 5.9L6.1 12Z" fill={secondary} />
          <circle cx="12" cy="12" r="1.8" fill={primary} />
        </>
      )}
      {hash % 8 === 7 && (
        <>
          <RadialPetals d="M12 2.1 15.2 8.9 12 12 8.8 8.9Z" fill={primary} />
          <RadialPetals d="M12 5.7 17.1 12 12 18.3 6.9 12Z" fill={secondary} />
          <circle cx="12" cy="12" r="1.5" fill={primary} />
        </>
      )}
    </svg>
  );
}
