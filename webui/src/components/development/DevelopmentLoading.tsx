import { useEffect, useState } from "react";

export function DevelopmentLoading({ label, variant = "conversation" }: {
  label: string; variant?: "conversation" | "list" | "inline";
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 400);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return <div role="status" aria-label={label} aria-busy="true"
    className={variant === "inline" ? "text-caption text-muted-foreground" : variant === "list" ? "space-y-3 px-3 py-2" : "mx-auto w-full max-w-4xl space-y-5 p-5"}>
    <p className="text-caption text-muted-foreground">{label}</p>
    {variant !== "inline" && <div aria-hidden className="space-y-3 motion-safe:animate-pulse">
      {[0, 1, 2].map((index) => <div key={index} className="space-y-2">
        <div className="h-3 w-3/4 rounded-md bg-muted" />
        {variant === "conversation" && <div className="h-3 w-1/2 rounded-md bg-muted" />}
      </div>)}
    </div>}
  </div>;
}
