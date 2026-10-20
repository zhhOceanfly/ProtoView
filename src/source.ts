import * as vscode from "vscode";
import {
  ProtoSourceConfig,
  collectProtoFiles,
  sourceCacheDir,
  sourceSummary,
  syncGitSource,
} from "./sourceCore";

export type { SourceMode, SourceLogger, ProtoSourceConfig } from "./sourceCore";
export {
  collectProtoFiles,
  sourceCacheDir,
  sourceSummary,
  syncGitSource,
} from "./sourceCore";

const STATE_KEY = "protoview.source";

export function loadSourceConfig(context: vscode.ExtensionContext): ProtoSourceConfig {
  const saved = context.workspaceState.get<Partial<ProtoSourceConfig>>(STATE_KEY) ?? {};
  return {
    mode: saved.mode === "git" ? "git" : "workspace",
    gitUrl: saved.gitUrl?.trim() ?? "",
    gitBranch: saved.gitBranch?.trim() || "main",
    localPath: saved.localPath ?? "",
    dirPath: saved.dirPath?.trim() ?? "",
    lastError: saved.lastError ?? "",
    lastLog: saved.lastLog ?? "",
    lastSyncedAt: saved.lastSyncedAt ?? 0,
  };
}

export async function saveSourceConfig(
  context: vscode.ExtensionContext,
  config: ProtoSourceConfig,
): Promise<void> {
  await context.workspaceState.update(STATE_KEY, config);
}
