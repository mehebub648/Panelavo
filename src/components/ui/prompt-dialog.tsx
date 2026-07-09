"use client";

import { useState } from "react";
import { Button } from "./button";
import { Input } from "./input";

export function PromptDialog({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  variant = "default",
  placeholder = "",
  type = "text",
  required = true,
}: {
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  variant?: "danger" | "default";
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (required && !value.trim()) return;
    onConfirm(value);
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/40 p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        <h3 className="text-lg font-bold text-slate-900">{title}</h3>
        <div className="mt-2 text-sm text-slate-500">{message}</div>
        <form onSubmit={handleSubmit} className="mt-4">
          <div className="space-y-2">
            <Input
              type={type}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              required={required}
              autoFocus
            />
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onCancel}>
              {cancelText}
            </Button>
            <Button
              type="submit"
              variant={variant === "danger" ? "danger" : "default"}
              disabled={required && !value.trim()}
            >
              {confirmText}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
