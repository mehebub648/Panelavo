// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentUnavailable, EnvManager } from "./env-manager";

const initialData = {
  path: "/home/site/htdocs/app",
  profilePath: "/home/site/.profile",
  userEnv: [],
  files: [
    { name: ".env", exists: true, entries: [{ key: "API_URL", value: "old" }] },
    {
      name: ".env.local",
      exists: true,
      entries: [{ key: "DEBUG", value: "0" }],
    },
  ],
};

afterEach(() => cleanup());

describe("environment editing safeguards", () => {
  it("asks before switching files with unsaved changes", () => {
    render(
      <EnvManager domain="site.test" initialData={initialData} canWrite />,
    );

    fireEvent.change(screen.getByLabelText("Value for API_URL"), {
      target: { value: "new" },
    });
    fireEvent.click(screen.getByRole("button", { name: ".env.local" }));

    const dialog = screen.getByRole("dialog", {
      name: "Discard unsaved environment changes?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Value for API_URL")).toHaveValue("new");

    fireEvent.click(screen.getByRole("button", { name: ".env.local" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Discard and switch",
      }),
    );
    expect(screen.getByLabelText("Value for DEBUG")).toHaveValue("0");
  });

  it("warns before leaving while changes are unsaved", () => {
    render(
      <>
        <a href="https://example.com/sites">Websites</a>
        <EnvManager domain="site.test" initialData={initialData} canWrite />
      </>,
    );
    fireEvent.change(screen.getByLabelText("Value for API_URL"), {
      target: { value: "new" },
    });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("link", { name: "Websites" }));
    const dialog = screen.getByRole("dialog", {
      name: "Discard unsaved environment changes?",
    });
    expect(dialog).toHaveTextContent("Leaving this page will discard");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Value for API_URL")).toHaveValue("new");
  });

  it("shows a retryable error without rendering environment values", () => {
    const retry = vi.fn();
    render(<EnvironmentUnavailable onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Environment is unavailable",
    );
    expect(screen.queryByText("API_URL")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
