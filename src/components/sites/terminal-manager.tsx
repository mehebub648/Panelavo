"use client";

import { useEffect, useRef, useState } from "react";
import {
  Eraser,
  KeyRound,
  LoaderCircle,
  Server,
  SquareTerminal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyValue } from "@/components/ui/copy-value";
import { cn } from "@/lib/utils";

export type TerminalData = {
  user: string;
  home: string;
  root: string;
  host: string;
};

type HistoryEntry = {
  id: number;
  cwd: string;
  command: string;
  output: string;
  exitCode: number;
  timedOut?: boolean;
};

let entryId = 0;

export function TerminalManager({
  domain,
  initialData,
  canWrite,
}: {
  domain: string;
  initialData: TerminalData;
  canWrite: boolean;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cwd, setCwd] = useState(initialData.root);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, busy]);

  function shortPath(path: string) {
    return path === initialData.home
      ? "~"
      : path.startsWith(`${initialData.home}/`)
        ? `~${path.slice(initialData.home.length)}`
        : path;
  }

  async function run(command: string) {
    const trimmed = command.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setInput("");
    setHistoryIndex(-1);
    const startedIn = cwd;
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(domain)}/sections/terminal`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "exec", command: trimmed, cwd }),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "The command could not be executed.");
      const data = result.data as {
        output: string;
        exitCode: number;
        timedOut?: boolean;
        cwd: string;
      };
      setEntries((current) => [
        ...current,
        {
          id: ++entryId,
          cwd: startedIn,
          command: trimmed,
          output: data.output,
          exitCode: data.exitCode,
          timedOut: data.timedOut,
        },
      ]);
      if (data.cwd) setCwd(data.cwd);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The command could not be executed.",
      );
    } finally {
      setBusy(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function recallHistory(direction: 1 | -1) {
    if (!entries.length) return;
    const next =
      historyIndex === -1
        ? direction === 1
          ? entries.length - 1
          : -1
        : Math.min(entries.length - 1, Math.max(-1, historyIndex - direction));
    setHistoryIndex(next);
    setInput(next === -1 ? "" : entries[next].command);
  }

  const sshCommand = `ssh ${initialData.user}@${initialData.host || "<server-ip>"}`;

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <SquareTerminal className="h-5 w-5 text-emerald-400" />
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                {initialData.user}@{domain}
              </h3>
              <p className="font-mono text-xs text-slate-500">{shortPath(cwd)}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            disabled={!entries.length}
            onClick={() => setEntries([])}
          >
            <Eraser className="h-4 w-4" /> Clear
          </Button>
        </div>

        <div
          ref={scrollRef}
          className="max-h-[52vh] min-h-[18rem] overflow-auto p-5 font-mono text-xs leading-5"
          aria-live="polite"
          role="log"
          aria-label="Terminal output"
        >
          {!entries.length && (
            <p className="text-slate-500">
              Commands run as <b className="text-slate-300">{initialData.user}</b> with a
              3-minute limit — the same access as SSH, never root. Long-lived processes
              (dev servers, watchers) will be stopped when the limit is reached; use PM2
              or Operations for anything that must keep running.
            </p>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="mb-3">
              <p className="break-all text-slate-300">
                <span className="text-emerald-400">{shortPath(entry.cwd)} $</span>{" "}
                {entry.command}
                {entry.timedOut ? (
                  <span className="ml-2 text-amber-400">(timed out)</span>
                ) : entry.exitCode !== 0 ? (
                  <span className="ml-2 text-red-400">(exit {entry.exitCode})</span>
                ) : null}
              </p>
              {entry.output && (
                <pre className="mt-1 whitespace-pre-wrap break-words text-slate-400">
                  {entry.output}
                </pre>
              )}
            </div>
          ))}
          {busy && (
            <p className="flex items-center gap-2 text-slate-500">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Running…
            </p>
          )}
        </div>

        <form
          className="flex items-center gap-2 border-t border-slate-800 px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(input);
          }}
        >
          <span className="shrink-0 font-mono text-xs text-emerald-400">
            {shortPath(cwd)} $
          </span>
          <input
            ref={inputRef}
            value={input}
            disabled={!canWrite || busy}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                recallHistory(1);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                recallHistory(-1);
              }
            }}
            placeholder={
              canWrite
                ? "Type a command and press Enter"
                : "Your role has read-only access to this website."
            }
            aria-label="Terminal command"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full bg-transparent font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
        </form>
      </section>

      <section className="rounded-2xl border border-white/60 bg-white/75 p-5 shadow-card backdrop-blur-md sm:p-6">
        <div className="flex gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-600">
            <Server className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="font-bold">Connect from your own terminal</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Full interactive shell and file transfer with the same site user.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">SSH</p>
            <CopyValue value={sshCommand} className="mt-2 w-full px-2 py-1.5">
              <code className="text-sm text-slate-700">{sshCommand}</code>
            </CopyValue>
            <p className="mt-2 text-xs text-slate-500">
              SFTP works with the same credentials:{" "}
              <code>sftp {initialData.user}@{initialData.host || "<server-ip>"}</code>
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">
              <KeyRound className="h-3.5 w-3.5" /> Authentication
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-5 text-slate-600">
              <li>
                Use the <b>{initialData.user}</b> password chosen when the website was
                created, or reset it in CloudPanel.
              </li>
              <li>
                For key-based login, append your public key to{" "}
                <code className={cn("break-all")}>{initialData.home}/.ssh/authorized_keys</code>{" "}
                (you can do that right here in the terminal).
              </li>
              <li>
                Additional shell accounts can be created under{" "}
                <b>Security → SSH/FTP access</b>.
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
