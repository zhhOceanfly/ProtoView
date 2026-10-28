import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { exec } from "child_process";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { materializeGhzUpload, materializeProtoUpload } from "./uploadProtoDir";

type ClientHostCtor = {
  new (options: {
    workspaceRoot: string;
    showGoogle?: boolean;
    initialSource?: { mode?: string; gitUrl?: string; gitBranch?: string };
    log?: (line: string) => void;
  }): {
    reload(syncGit?: boolean): Promise<void>;
    handleMessage(
      message: {
        type?: string;
        file?: string;
        line?: number;
        editor?: string;
        payload?: Record<string, unknown>;
      },
      send: (m: Record<string, unknown>) => void,
    ): Promise<void>;
    sourceLabel(): string;
  };
};

// Packaged next to dist/ as dist/core/* (copied by scripts/build-cli.js)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ClientHost } = require("./core/hostCore") as { ClientHost: ClientHostCtor };

export interface ServerOptions {
  publicDir: string;
  workspaceRoot: string;
  port: number;
  openBrowser: boolean;
  showGoogle: boolean;
  gitUrl: string;
  gitBranch: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

export async function startServer(options: ServerOptions): Promise<void> {
  const host = new ClientHost({
    workspaceRoot: options.workspaceRoot,
    showGoogle: options.showGoogle,
    initialSource: options.gitUrl
      ? { mode: "git", gitUrl: options.gitUrl, gitBranch: options.gitBranch || "main" }
      : { mode: "workspace" },
    log: (line) => console.log(`[protoview] ${line}`),
  });

  console.log(`[protoview] loading protos from ${options.gitUrl || options.workspaceRoot} …`);
  await host.reload(Boolean(options.gitUrl));

  const server = http.createServer((req, res) => {
    void serveStatic(options.publicDir, req, res);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocket) => {
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };
    socket.on("message", (raw: RawData) => {
      void (async () => {
        try {
          const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Buffer.from(raw as ArrayBuffer).toString("utf8");
          const message = JSON.parse(text) as {
            type?: string;
            payload?: {
              name?: string;
              files?: Array<{ path: string; content: string }>;
              base64?: string;
            };
          };
          // 浏览器选目录上传：只落盘并回填路径，等用户点「应用并刷新」
          if (message.type === "uploadProtoDir") {
            const result = await materializeProtoUpload(message.payload || {});
            if (!result.count) {
              send({ type: "toast", level: "err", text: "目录中未找到 .proto 文件" });
              return;
            }
            send({
              type: "pickedProtoDir",
              path: result.dir,
              label: result.label,
              count: result.count,
            });
            return;
          }
          if (message.type === "uploadGhzBinary") {
            const file = await materializeGhzUpload(message.payload || {});
            if (file) send({ type: "pickedGhzBinary", path: file });
            return;
          }
          await host.handleMessage(message, send);
        } catch (error) {
          send({
            type: "invokeResult",
            ok: false,
            status: "ERROR",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const url = `http://127.0.0.1:${options.port}/`;
  console.log(`[protoview] ProtoView Client → ${url}`);
  console.log(`[protoview] source: ${host.sourceLabel()}`);
  console.log("[protoview] press Ctrl+C to stop");

  if (options.openBrowser) openUrl(url);
}

async function serveStatic(
  publicDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const filePath = path.normalize(path.join(publicDir, rel));
    if (!filePath.startsWith(path.normalize(publicDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

function openUrl(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"`
      : platform === "darwin" ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (error) => {
    if (error) console.warn(`[protoview] could not open browser: ${error.message}`);
  });
}
