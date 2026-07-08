import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-panel-500 focus:ring-4 focus:ring-panel-500/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
