import { Boxes } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({
  compact = false,
  inverse = false,
}: {
  compact?: boolean;
  inverse?: boolean;
}) {
  const name = process.env.NEXT_PUBLIC_APP_NAME ?? "panelavo";
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "grid h-10 w-10 place-items-center rounded-xl",
          inverse ? "bg-white/15 text-white" : "bg-panel-600 text-white",
        )}
      >
        <Boxes className="h-5 w-5" />
      </span>
      {!compact && (
        <span
          className={cn(
            "text-[17px] font-bold tracking-tight",
            inverse ? "text-white" : "text-ink",
          )}
        >
          {name}
        </span>
      )}
    </div>
  );
}
