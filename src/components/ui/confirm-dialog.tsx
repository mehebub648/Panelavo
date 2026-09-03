"use client";

import React, { useState } from "react";
import { Button } from "./button";

export function ConfirmDialog({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmationPhrase,
  onConfirm,
  onCancel,
  variant = "danger",
}: {
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmationPhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
}) {
  const [confirmation, setConfirmation] = useState("");
  const confirmed =
    confirmationPhrase === undefined || confirmation === confirmationPhrase;

  return (
    <div className="animate-in fade-in fixed inset-0 z-[100] grid place-items-center bg-slate-950/40 p-4 duration-200">
      <div className="animate-in zoom-in-95 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl duration-200">
        <h3 className="text-lg font-bold text-slate-900">{title}</h3>
        <div className="mt-2 text-sm text-slate-500">{message}</div>
        {confirmationPhrase && (
          <label className="mt-5 block text-sm font-medium text-slate-700">
            Type <strong>{confirmationPhrase}</strong> to continue
            <input
              autoComplete="off"
              autoFocus
              className="focus:border-brand focus:ring-brand/15 mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:ring-2"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "default"}
            disabled={!confirmed}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
