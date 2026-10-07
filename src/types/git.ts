import type { DeploymentResult } from "@/lib/deployment";

export type GitChange = {
  status: string;
  path: string;
  originalPath?: string;
};

export type GitCommit = {
  hash: string;
  author: string;
  date: string;
  subject: string;
};

export type GitGraphCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: string[];
  author: string;
  date: string;
  subject: string;
};

export type GitOperation = null | "merge" | "rebase" | "cherry-pick" | "revert";

export type GitData = DeploymentResult & {
  isRepository: boolean;
  path: string;
  branch?: string;
  head?: string;
  remotes?: string[][];
  branches?: string[];
  remoteBranches?: string[];
  changes?: GitChange[];
  commits?: GitCommit[];
  graph?: GitGraphCommit[];
  selectedDiff?: { path: string; diff: string };
  notice?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  cloneReadiness?: {
    status: "empty" | "scaffold" | "files" | "blocked";
    files: string[];
    detail: string;
  };
  state?: {
    operation: GitOperation;
    conflictedFiles: string[];
  };
  backup?: {
    created?: boolean;
    path?: string;
    detail: string;
  };
};
