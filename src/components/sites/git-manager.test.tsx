// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { GitData } from "@/types/git";
import { GitManager } from "./git-manager";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}));
vi.mock("./deployment-manager", () => ({
  DeploymentManager: () => <div>Deployment panel</div>,
  DeploymentOutput: () => <div>Deployment output</div>,
}));
vi.mock("./deployment-key", () => ({
  DeploymentKey: () => <div>Deployment key</div>,
}));

const repository: GitData = {
  isRepository: true,
  path: "/home/site/htdocs/app",
  branch: "main",
  head: "cccccccccccccccccccccccccccccccccccccccc",
  remotes: [["origin", "git@example.test:owner/repo.git", "(fetch)"]],
  branches: ["main", "feature/local"],
  remoteBranches: ["origin/main", "origin/release"],
  changes: [],
  commits: [],
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  state: { operation: null, conflictedFiles: [] },
  graph: [
    {
      hash: "cccccccccccccccccccccccccccccccccccccccc",
      shortHash: "ccccccc",
      parents: [
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      refs: ["HEAD -> main", "origin/main"],
      author: "Ada",
      date: "2026-10-07",
      subject: "Merge release",
    },
    {
      hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      shortHash: "bbbbbbb",
      parents: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      refs: [],
      author: "Grace",
      date: "2026-10-06",
      subject: "Main work",
    },
    {
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortHash: "aaaaaaa",
      parents: [],
      refs: ["origin/release"],
      author: "Linus",
      date: "2026-10-05",
      subject: "Start release",
    },
  ],
};

function response(value: unknown) {
  return { json: async () => value } as Response;
}

function renderManager(
  initialData: GitData = repository,
  options: { canWrite?: boolean; apiBase?: string } = {},
) {
  return render(
    <GitManager
      domain="site.test"
      initialData={initialData}
      canWrite={options.canWrite ?? true}
      apiBase={options.apiBase}
    />,
  );
}

function postBody(call: unknown[]) {
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe("GitManager", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/sites/site.test/git");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("persists accessible tab selection in browser history", async () => {
    renderManager();

    const changes = screen.getByRole("tab", { name: "Changes" });
    fireEvent.click(changes);
    expect(changes).toHaveAttribute("aria-selected", "true");
    expect(window.location.search).toBe("?gitTab=changes");

    fireEvent.keyDown(changes, { key: "ArrowRight" });
    const branches = screen.getByRole("tab", { name: "Branches" });
    expect(branches).toHaveAttribute("aria-selected", "true");
    expect(branches).toHaveFocus();

    window.history.pushState(null, "", "?gitTab=history");
    fireEvent(window, new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("uses exact branch refs for create, checkout, tracking, and merge actions", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ success: true, data: repository }),
    );
    renderManager();
    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));

    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    const createDialog = screen.getByRole("dialog", { name: "Create branch" });
    fireEvent.change(within(createDialog).getByLabelText("Branch name"), {
      target: { value: "feature/new-ui" },
    });
    fireEvent.click(
      within(createDialog).getByRole("button", { name: "Create branch" }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postBody(vi.mocked(fetch).mock.calls[0])).toEqual({
      action: "create-branch",
      branch: "feature/new-ui",
    });

    const local = screen.getByText("Local branches").closest("section")!;
    fireEvent.click(within(local).getByRole("button", { name: "Switch" }));
    const checkout = screen.getByRole("dialog", {
      name: "Switch to feature/local?",
    });
    expect(checkout).toHaveTextContent("Website files may change immediately");
    fireEvent.click(
      within(checkout).getByRole("button", { name: "Switch branch" }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(postBody(vi.mocked(fetch).mock.calls[1])).toEqual({
      action: "checkout",
      branch: "feature/local",
    });

    fireEvent.change(screen.getByLabelText("Remote branch"), {
      target: { value: "origin/release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set upstream" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(postBody(vi.mocked(fetch).mock.calls[2])).toEqual({
      action: "set-upstream",
      branch: "origin/release",
    });

    const remote = screen.getByText("Remote branches").closest("section")!;
    fireEvent.click(within(remote).getByRole("button", { name: "Merge" }));
    const merge = screen.getByRole("dialog", {
      name: "Merge origin/release into main?",
    });
    expect(merge).toHaveTextContent(
      "Preview: merge the exact ref origin/release",
    );
    fireEvent.click(
      within(merge).getByRole("button", { name: "Merge branch" }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(postBody(vi.mocked(fetch).mock.calls[3])).toEqual({
      action: "merge",
      branch: "origin/release",
    });
  });

  it("draws structured parent connections and exposes history as text", () => {
    renderManager();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    const graph = screen.getByRole("img", {
      name: "Commit graph showing parent connections",
    });
    expect(graph.querySelectorAll("path")).toHaveLength(3);
    expect(screen.getByText(/Commit ccccccc: Merge release/)).toHaveTextContent(
      "Parents: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(screen.getByText("HEAD -> main")).toBeVisible();
  });

  it("places separate branch tips in distinct graph lanes", () => {
    const branched: GitData = {
      ...repository,
      graph: [
        {
          hash: "1111111111111111111111111111111111111111",
          shortHash: "1111111",
          parents: ["0000000000000000000000000000000000000000"],
          refs: ["main"],
          author: "Ada",
          date: "2026-10-07",
          subject: "Main tip",
        },
        {
          hash: "2222222222222222222222222222222222222222",
          shortHash: "2222222",
          parents: ["0000000000000000000000000000000000000000"],
          refs: ["feature"],
          author: "Grace",
          date: "2026-10-07",
          subject: "Feature tip",
        },
        {
          hash: "0000000000000000000000000000000000000000",
          shortHash: "0000000",
          parents: [],
          refs: [],
          author: "Linus",
          date: "2026-10-06",
          subject: "Shared base",
        },
      ],
    };
    renderManager(branched);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    const nodes = screen
      .getByRole("img", { name: "Commit graph showing parent connections" })
      .querySelectorAll("circle");
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toHaveAttribute("cx", "22");
    expect(nodes[1]).toHaveAttribute("cx", "50");
    expect(nodes[2]).toHaveAttribute("cx", "22");
  });

  it("requires explicit preservation before cloning around existing files", async () => {
    const disconnected: GitData = {
      isRepository: false,
      path: "/home/site/htdocs/app",
      cloneReadiness: {
        status: "files",
        files: ["index.php", "storage/data.json"],
        detail: "Existing application files need a backup before cloning.",
      },
    };
    vi.mocked(fetch).mockResolvedValue(
      response({ success: true, data: repository }),
    );
    renderManager(disconnected);
    fireEvent.click(screen.getByRole("tab", { name: "Connection & Recovery" }));

    expect(screen.getByText("index.php")).toBeVisible();
    expect(screen.getByText("storage/data.json")).toBeVisible();
    expect(screen.getByText("Deployment key")).toBeVisible();
    expect(
      screen.getByText(/Add this website's public key.*before cloning/),
    ).toBeVisible();
    const clone = screen.getByRole("button", { name: "Clone repository" });
    expect(clone).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "git@example.test:owner/repo.git" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Back up and preserve the listed files/,
      }),
    );
    expect(clone).toBeEnabled();
    fireEvent.click(clone);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postBody(vi.mocked(fetch).mock.calls[0])).toEqual({
      action: "clone",
      url: "git@example.test:owner/repo.git",
      branch: "",
      preserveExisting: true,
    });
  });

  it("keeps actionable failures visible and refreshes repository state", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({
          success: false,
          error: { message: "Authentication failed for origin" },
        }),
      )
      .mockResolvedValueOnce(response({ success: true, data: repository }));
    renderManager();
    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Authentication failed for origin");
    expect(alert).toHaveTextContent("add this website's deployment key");
    expect(
      within(alert).getByRole("button", {
        name: "Open Connection & Recovery",
      }),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]).toEqual([
      "/api/sites/site.test/sections/git",
      { cache: "no-store" },
    ]);
  });

  it("shows recovery links and restricts replacement choices to merge conflicts", async () => {
    const conflicted: GitData = {
      ...repository,
      state: { operation: "merge", conflictedFiles: ["src/app.ts"] },
    };
    vi.mocked(fetch).mockResolvedValue(
      response({ success: true, data: conflicted }),
    );
    renderManager(conflicted, {
      apiBase: "/api/fleet/servers/server-1/proxy",
    });
    fireEvent.click(screen.getByRole("tab", { name: "Connection & Recovery" }));

    expect(screen.getByRole("link", { name: "Open Files" })).toHaveAttribute(
      "href",
      "/servers/server-1/sites/site.test/file-manager?path=src%2Fapp.ts",
    );
    expect(screen.getByRole("link", { name: "Open Terminal" })).toHaveAttribute(
      "href",
      "/servers/server-1/sites/site.test/terminal",
    );
    expect(
      screen.getByRole("button", { name: "Continue merge" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Use ours" }));
    const replacement = screen.getByRole("dialog", {
      name: "Replace src/app.ts with ours?",
    });
    expect(replacement).toHaveTextContent(
      "Any manual edits in that file will be lost",
    );
    fireEvent.click(
      within(replacement).getByRole("button", { name: "Use ours" }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(postBody(vi.mocked(fetch).mock.calls[0])).toEqual({
      action: "resolve-conflict",
      path: "src/app.ts",
      choice: "ours",
    });
  });

  it("shows status and history to read-only users without mutation controls", () => {
    renderManager(repository, { canWrite: false });
    expect(screen.getByText("Read-only access")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));
    expect(screen.getByText("feature/local")).toBeVisible();
    expect(screen.getByText("origin/release")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Create branch" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Switch" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("Merge release")).toBeVisible();
  });
});
