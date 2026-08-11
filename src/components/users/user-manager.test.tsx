// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserModal } from "./user-manager";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("UserModal", () => {
  it("is a centered modal with focus, Escape, and scroll locking", () => {
    const close = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(
      <UserModal title="Edit user" close={close}>
        <button>Save</button>
      </UserModal>,
    );
    expect(screen.getByRole("dialog", { name: "Edit user" }).classList.contains("rounded-2xl")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes from the backdrop but not dialog content", () => {
    const close = vi.fn();
    render(<UserModal title="Create user" close={close}><button>Inside</button></UserModal>);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }));
    expect(close).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog.parentElement!);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
