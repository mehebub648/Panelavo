"use client";

import Editor, { loader, type BeforeMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";

const nginxDirectives = [
  "server", "location", "listen", "server_name", "root", "index", "try_files",
  "proxy_pass", "proxy_set_header", "fastcgi_pass", "fastcgi_param", "include",
  "access_log", "error_log", "ssl_certificate", "ssl_certificate_key", "return",
  "rewrite", "client_max_body_size", "add_header", "gzip", "expires", "allow", "deny",
];

loader.config({ paths: { vs: "/monaco/vs" } });

let preloadPromise: ReturnType<typeof loader.init> | null = null;
export function preloadCodeEditor() {
  preloadPromise ??= loader.init();
  return preloadPromise;
}

const beforeMount: BeforeMount = (monaco) => {
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === "nginx")) {
    monaco.languages.register({ id: "nginx" });
    monaco.languages.setMonarchTokensProvider("nginx", {
      tokenizer: { root: [
        [/#.*$/, "comment"], [/$[a-zA-Z_][\w]*/, "variable"],
        [new RegExp(`\\b(${nginxDirectives.join("|")})\\b`), "keyword"],
        [/\b(on|off)\b/, "constant"], [/\b\d+[kKmMgG]?\b/, "number"],
        [/"[^"\\]*(?:\\.[^"\\]*)*"/, "string"], [/[{}]/, "delimiter.bracket"],
      ] },
    });
    monaco.languages.registerCompletionItemProvider("nginx", {
      provideCompletionItems: (model: editor.ITextModel, position: Position) => ({ suggestions: nginxDirectives.map((label) => ({
        label, kind: monaco.languages.CompletionItemKind.Keyword, insertText: label,
        range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: model.getWordUntilPosition(position).startColumn, endColumn: model.getWordUntilPosition(position).endColumn },
      })) }),
    });
  }
};

export function languageForFile(name: string) {
  const lower = name.toLowerCase();
  if (["nginx.conf", "vhost.conf"].includes(lower) || lower.endsWith(".nginx")) return "nginx";
  const extension = lower.split(".").pop();
  return ({ js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", json: "json", css: "css", scss: "scss", less: "less", html: "html", htm: "html", php: "php", py: "python", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", xml: "xml", md: "markdown", sql: "sql", env: "plaintext" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

export function CodeEditor({ value, onChange, language, height = "60vh", ariaLabel = "Code editor" }: {
  value: string; onChange: (value: string) => void; language: string; height?: string; ariaLabel?: string;
}) {
  const options: editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true, fontSize: 14, lineHeight: 22, fontLigatures: true,
    minimap: { enabled: true }, smoothScrolling: true, scrollBeyondLastLine: false,
    wordWrap: "off", tabSize: 2, insertSpaces: true, formatOnPaste: true,
    suggestOnTriggerCharacters: true, quickSuggestions: true, parameterHints: { enabled: true },
    bracketPairColorization: { enabled: true }, guides: { bracketPairs: true, indentation: true },
    padding: { top: 14, bottom: 14 }, renderWhitespace: "selection",
  };
  return <div className="overflow-hidden rounded-xl border border-slate-700 bg-[#1e1e1e] shadow-inner" aria-label={ariaLabel}>
    <Editor beforeMount={beforeMount} height={height} language={language} theme="vs-dark" value={value} onChange={(next) => onChange(next ?? "")} options={options} loading={<div className="grid h-full place-items-center text-sm text-slate-300">Loading editor…</div>} />
  </div>;
}
