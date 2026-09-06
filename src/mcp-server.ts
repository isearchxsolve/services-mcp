/**
 * MCP (Model Context Protocol) Server
 * Allows external LLMs (Claude, GPT, Codex) to interface with the Emergent.sh clone
 * Uses McpServer from the SDK for high-level API
 */

import { 
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  MCPTool,
  MCPResource,
  MCPResourceContent,
  MCPCallToolRequest,
  MCPCallToolResult,
  MCPListResourcesRequest,
  MCPListResourcesResult,
  MCPReadResourceRequest,
  MCPListToolsResult,
  MCPSession,
  MCPClientCapabilities,
  MCPServerCapabilities,
  MCPMessage,
  MCPNotification,
  MCPConfig,
  FileSystemToolArgs,
  TerminalToolArgs,
  SandboxToolArgs,
  GitToolArgs,
} from "./types.js";

const DEFAULT_CONFIG: MCPConfig = {
  port: 3001,
  host: "localhost",
  path: "/mcp",
  allowedOrigins: ["*"],
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
};

export class MCPServer extends EventEmitter<{
  sessionCreated: (session: MCPSession) => void;
  sessionClosed: (sessionId: string) => void;
  toolCalled: (sessionId: string, toolName: string, args: unknown) => void;
  resourceAccessed: (sessionId: string, uri: string) => void;
  error: (error: Error, sessionId?: string) => void;
}> {
  private config: MCPConfig;
  private mcpServer: McpServer;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private sseTransport: SSEServerTransport | null = null;
  private wsServer: WebSocketServer | null = null;
  private sessions: Map<string, MCPSession> = new Map();
  private sessionCleanupTimer: NodeJS.Timeout | null = null;
  private fileSystem: Map<string, string> = new Map();
  private sandboxManager: SandboxManager | null = null;

  constructor(config?: Partial<MCPConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.mcpServer = new McpServer(
      { name: "emergent-sh-clone", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true }, logging: {} } }
    );
    this.setupTools();
    this.setupResources();
  }

  setSandboxManager(manager: SandboxManager): void { this.sandboxManager = manager; }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer();
      this.httpServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
        if (req.url?.startsWith(this.config.path)) { this.handleSSE(req, res); }
        else if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", server: "emergent-mcp" })); }
        else { res.writeHead(404); res.end("Not found"); }
      });
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.wsServer = new WebSocketServer({ server: this.httpServer });
        this.wsServer.on("connection", (ws: WebSocket, req: IncomingMessage) => this.handleWSConnection(ws, req));
        this.startSessionCleanup();
        resolve();
      });
      this.httpServer.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.sessionCleanupTimer) { clearInterval(this.sessionCleanupTimer); this.sessionCleanupTimer = null; }
    for (const sessionId of this.sessions.keys()) { await this.closeSession(sessionId); }
    if (this.wsServer) { this.wsServer.close(); this.wsServer = null; }
    if (this.httpServer) { await new Promise<void>(r => this.httpServer!.close(() => r())); this.httpServer = null; }
    await this.mcpServer.close();
  }

  getSessionCount(): number { return this.sessions.size; }
  getSession(sessionId: string): MCPSession | undefined { return this.sessions.get(sessionId); }
  broadcastNotification(notification: MCPNotification): void { this.emit("notification", notification); }
  getTools(): MCPTool[] { return this.getAvailableTools(); }
  async callTool(request: MCPCallToolRequest): Promise<MCPCallToolResult> { return this.handleToolCall(request); }
  async listResources(request: MCPListResourcesRequest): Promise<MCPListResourcesResult> { return this.handleListResources(request); }
  async readResource(request: MCPReadResourceRequest): Promise<MCPResourceContent> { return this.handleReadResource(request); }

  private setupTools(): void {
    const fs = this.fileSystem;
    const sm = this.sandboxManager;
    const uuid = uuidv4;

    this.mcpServer.registerTool("filesystem_read", { title: "Read File", description: "Read a file from the virtual file system", inputSchema: { operation: z.literal("read"), path: z.string() } }, async (args) => {
      const content = fs.get(args.path); if (content === undefined) throw new Error(`File not found: ${args.path}`); return { content: [{ type: "text", text: JSON.stringify({ path: args.path, content }) }] };
    });
    this.mcpServer.registerTool("filesystem_write", { title: "Write File", description: "Write a file to the virtual file system", inputSchema: { operation: z.literal("write"), path: z.string(), content: z.string() } }, async (args) => { fs.set(args.path, args.content || ""); return { content: [{ type: "text", text: JSON.stringify({ path: args.path, success: true }) }] }; });
    this.mcpServer.registerTool("filesystem_list", { title: "List Directory", description: "List directory contents", inputSchema: { operation: z.literal("list"), path: z.string().default("/") } }, async (args) => { const path = args.path || "/"; const entries: Array<{name:string,type:"file"|"directory"}> = []; for (const [key] of fs) { if (key.startsWith(path) && key !== path) { const relative = key.slice(path.length).replace(/^\//, ""); const parts = relative.split("/"); if (parts.length === 1 || (parts.length === 2 && parts[1] === "")) entries.push({ name: parts[0], type: "file" }); } } return { content: [{ type: "text", text: JSON.stringify({ path, entries }) }] }; });
    this.mcpServer.registerTool("filesystem_delete", { title: "Delete File/Directory", description: "Delete a file or directory", inputSchema: { operation: z.literal("delete"), path: z.string() } }, async (args) => { const deleted = fs.delete(args.path); return { content: [{ type: "text", text: JSON.stringify({ path: args.path, deleted }) }] }; });
    this.mcpServer.registerTool("filesystem_move", { title: "Move/Rename File", description: "Move/rename a file or directory", inputSchema: { operation: z.literal("move"), path: z.string(), targetPath: z.string() } }, async (args) => { const content = fs.get(args.path); if (content === undefined) throw new Error(`Source not found: ${args.path}`); fs.delete(args.path); fs.set(args.targetPath!, content); return { content: [{ type: "text", text: JSON.stringify({ oldPath: args.path, newPath: args.targetPath, success: true }) }] }; });
    this.mcpServer.registerTool("filesystem_search", { title: "Search Files", description: "Search files by pattern", inputSchema: { operation: z.literal("search"), path: z.string().default("/"), pattern: z.string() } }, async (args) => { const regex = new RegExp(args.pattern || ""); const results: Array<{ path: string }> = []; for (const [key] of fs) { if (regex.test(key)) results.push({ path: key }); } return { content: [{ type: "text", text: JSON.stringify({ pattern: args.pattern, results }) }] }; });

    this.mcpServer.registerTool("terminal_exec", { title: "Execute Command", description: "Execute a command in the sandbox terminal", inputSchema: { operation: z.literal("exec"), command: z.string(), args: z.array(z.string()).optional(), workingDir: z.string().optional(), environment: z.record(z.string()).optional(), sessionId: z.string() } }, async (args) => { if (!sm) throw new Error("Sandbox manager not configured"); const session = sm.getSession(args.sessionId!); if (!session) throw new Error(`Session not found: ${args.sessionId}`); return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, command: args.command, args: args.args, output: "Command executed (simulated)", exitCode: 0 }) }] }; });
    this.mcpServer.registerTool("terminal_spawn", { title: "Spawn Process", description: "Spawn a background process in the sandbox", inputSchema: { operation: z.literal("spawn"), command: z.string(), args: z.array(z.string()).optional(), workingDir: z.string().optional(), environment: z.record(z.string()).optional(), sessionId: z.string() } }, async (args) => { if (!sm) throw new Error("Sandbox manager not configured"); const session = sm.getSession(args.sessionId!); if (!session) throw new Error(`Session not found: ${args.sessionId}`); return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, command: args.command, args: args.args, processId: uuid(), status: "running" }) }] }; });

    this.mcpServer.registerTool("sandbox_create", { title: "Create Sandbox", description: "Create a new sandbox session", inputSchema: { operation: z.literal("create"), userId: z.string(), projectId: z.string(), config: z.record(z.unknown()).optional() } }, async (args) => { if (!sm) throw new Error("Sandbox manager not configured"); const session = await sm.createSession(args.userId!, args.projectId!, args.config); return { content: [{ type: "text", text: JSON.stringify({ sessionId: session.id, status: "created" }) }] }; });
    this.mcpServer.registerTool("sandbox_start", { title: "Start Sandbox", description: "Start a sandbox session", inputSchema: { operation: z.literal("start"), sessionId: z.string() } }, async (args) => { if (!sm) throw new Error("Sandbox manager not configured"); await sm.startSession(args.sessionId!); return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, status: "running" }) }] }; });
    this.mcpServer.registerTool("sandbox_stop", { title: "Stop Sandbox", description: "Stop a sandbox session", inputSchema: { operation: z.literal("stop"), sessionId: z.string() } }, async (args) => { if (!sm) throw new Error("Sandbox manager not configured"); await sm.stopSession(args.sessionId!); return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, status: "stopped" }) }] }; });
    this.mcpServer.registerTool("sandbox_logs", { title: "Get Sandbox Logs", description: "Get sandbox logs", inputSchema: { operation: z.literal("logs"), sessionId: z.string(), lines: z.number().default(100) } }, async (args) => { if (!sm) throw new Error("Sandbox manager not configured"); return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, logs: [] }) }] }; });

    this.mcpServer.registerTool("git_status", { title: "Git Status", description: "Get Git repository status", inputSchema: { operation: z.literal("status"), sessionId: z.string() } }, async (args) => { return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, status: "clean", staged: [], unstaged: [], untracked: [] }) }] }; });
    this.mcpServer.registerTool("git_commit", { title: "Git Commit", description: "Commit changes to Git", inputSchema: { operation: z.literal("commit"), sessionId: z.string(), message: z.string() } }, async (args) => { return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, message: args.message, hash: uuid() }) }] }; });
    this.mcpServer.registerTool("git_push", { title: "Git Push", description: "Push to Git remote", inputSchema: { operation: z.literal("push"), sessionId: z.string(), remote: z.string().default("origin"), branch: z.string().default("main") } }, async (args) => { return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, remote: args.remote || "origin", branch: args.branch || "main", success: true }) }] }; });
    this.mcpServer.registerTool("git_pull", { title: "Git Pull", description: "Pull from Git remote", inputSchema: { operation: z.literal("pull"), sessionId: z.string(), remote: z.string().default("origin"), branch: z.string().default("main") } }, async (args) => { return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, remote: args.remote || "origin", branch: args.branch || "main", success: true }) }] }; });
    this.mcpServer.registerTool("git_history", { title: "Git History", description: "Get Git commit history", inputSchema: { operation: z.literal("history"), sessionId: z.string(), limit: z.number().default(50) } }, async (args) => { return { content: [{ type: "text", text: JSON.stringify({ sessionId: args.sessionId, commits: [] }) }] }; });
  }

  private setupResources(): void {
    const fs = this.fileSystem;
    const sessions = this.sessions;
    this.mcpServer.registerResource("filesystem", "emergent://filesystem", { title: "Virtual File System", description: "Access to the virtual file system", mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ files: Array.from(fs.keys()) }, null, 2) }] }));
    this.mcpServer.registerResource("sandbox", "emergent://sandbox", { title: "Sandbox Sessions", description: "Active sandbox sessions", mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ sessions: Array.from(sessions.values()) }, null, 2) }] }));
    this.mcpServer.registerResource("git", "emergent://git", { title: "Git Repositories", description: "Git repository information", mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ repositories: [] }, null, 2) }] }));
  }

  private getAvailableTools(): MCPTool[] {
    return [
      { name: "filesystem_read", description: "Read a file from the virtual file system", inputSchema: { type: "object", properties: { operation: { type: "string", const: "read" }, path: { type: "string" } }, required: ["operation", "path"] } },
      { name: "filesystem_write", description: "Write a file to the virtual file system", inputSchema: { type: "object", properties: { operation: { type: "string", const: "write" }, path: { type: "string" }, content: { type: "string" } }, required: ["operation", "path", "content"] } },
      { name: "filesystem_list", description: "List directory contents", inputSchema: { type: "object", properties: { operation: { type: "string", const: "list" }, path: { type: "string", default: "/" } }, required: ["operation"] } },
      { name: "filesystem_delete", description: "Delete a file or directory", inputSchema: { type: "object", properties: { operation: { type: "string", const: "delete" }, path: { type: "string" } }, required: ["operation", "path"] } },
      { name: "filesystem_move", description: "Move/rename a file or directory", inputSchema: { type: "object", properties: { operation: { type: "string", const: "move" }, path: { type: "string" }, targetPath: { type: "string" } }, required: ["operation", "path", "targetPath"] } },
      { name: "filesystem_search", description: "Search files by pattern", inputSchema: { type: "object", properties: { operation: { type: "string", const: "search" }, path: { type: "string", default: "/" }, pattern: { type: "string" } }, required: ["operation", "pattern"] } },
      { name: "terminal_exec", description: "Execute a command in the sandbox terminal", inputSchema: { type: "object", properties: { operation: { type: "string", const: "exec" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, workingDir: { type: "string" }, environment: { type: "object" }, sessionId: { type: "string" } }, required: ["operation", "command", "sessionId"] } },
      { name: "terminal_spawn", description: "Spawn a background process in the sandbox", inputSchema: { type: "object", properties: { operation: { type: "string", const: "spawn" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, workingDir: { type: "string" }, environment: { type: "object" }, sessionId: { type: "string" } }, required: ["operation", "command", "sessionId"] } },
      { name: "sandbox_create", description: "Create a new sandbox session", inputSchema: { type: "object", properties: { operation: { type: "string", const: "create" }, userId: { type: "string" }, projectId: { type: "string" }, config: { type: "object" } }, required: ["operation", "userId", "projectId"] } },
      { name: "sandbox_start", description: "Start a sandbox session", inputSchema: { type: "object", properties: { operation: { type: "string", const: "start" }, sessionId: { type: "string" } }, required: ["operation", "sessionId"] } },
      { name: "sandbox_stop", description: "Stop a sandbox session", inputSchema: { type: "object", properties: { operation: { type: "string", const: "stop" }, sessionId: { type: "string" } }, required: ["operation", "sessionId"] } },
      { name: "sandbox_logs", description: "Get sandbox logs", inputSchema: { type: "object", properties: { operation: { type: "string", const: "logs" }, sessionId: { type: "string" }, lines: { type: "number", default: 100 } }, required: ["operation", "sessionId"] } },
      { name: "git_status", description: "Get Git repository status", inputSchema: { type: "object", properties: { operation: { type: "string", const: "status" }, sessionId: { type: "string" } }, required: ["operation", "sessionId"] } },
      { name: "git_commit", description: "Commit changes to Git", inputSchema: { type: "object", properties: { operation: { type: "string", const: "commit" }, sessionId: { type: "string" }, message: { type: "string" } }, required: ["operation", "sessionId", "message"] } },
      { name: "git_push", description: "Push to Git remote", inputSchema: { type: "object", properties: { operation: { type: "string", const: "push" }, sessionId: { type: "string" }, remote: { type: "string", default: "origin" }, branch: { type: "string", default: "main" } }, required: ["operation", "sessionId"] } },
      { name: "git_pull", description: "Pull from Git remote", inputSchema: { type: "object", properties: { operation: { type: "string", const: "pull" }, sessionId: { type: "string" }, remote: { type: "string", default: "origin" }, branch: { type: "string", default: "main" } }, required: ["operation", "sessionId"] } },
      { name: "git_history", description: "Get Git commit history", inputSchema: { type: "object", properties: { operation: { type: "string", const: "history" }, sessionId: { type: "string" }, limit: { type: "number", default: 50 } }, required: ["operation", "sessionId"] } },
    ];
  }

  private async handleToolCall(request: MCPCallToolRequest): Promise<MCPCallToolResult> {
    const { name, arguments: args } = request;
    try {
      let result: unknown;
      if (name === "filesystem_read") result = await this.handleFilesystemRead(args as FileSystemToolArgs);
      else if (name === "filesystem_write") result = await this.handleFilesystemWrite(args as FileSystemToolArgs);
      else if (name === "filesystem_list") result = await this.handleFilesystemList(args as FileSystemToolArgs);
      else if (name === "filesystem_delete") result = await this.handleFilesystemDelete(args as FileSystemToolArgs);
      else if (name === "filesystem_move") result = await this.handleFilesystemMove(args as FileSystemToolArgs);
      else if (name === "filesystem_search") result = await this.handleFilesystemSearch(args as FileSystemToolArgs);
      else if (name === "terminal_exec") result = await this.handleTerminalExec(args as TerminalToolArgs);
      else if (name === "terminal_spawn") result = await this.handleTerminalSpawn(args as TerminalToolArgs);
      else if (name === "sandbox_create") result = await this.handleSandboxCreate(args as SandboxToolArgs);
      else if (name === "sandbox_start") result = await this.handleSandboxStart(args as SandboxToolArgs);
      else if (name === "sandbox_stop") result = await this.handleSandboxStop(args as SandboxToolArgs);
      else if (name === "sandbox_logs") result = await this.handleSandboxLogs(args as SandboxToolArgs);
      else if (name === "git_status") result = await this.handleGitStatus(args as GitToolArgs);
      else if (name === "git_commit") result = await this.handleGitCommit(args as GitToolArgs);
      else if (name === "git_push") result = await this.handleGitPush(args as GitToolArgs);
      else if (name === "git_pull") result = await this.handleGitPull(args as GitToolArgs);
      else if (name === "git_history") result = await this.handleGitHistory(args as GitToolArgs);
      else throw new Error(`Unknown tool: ${name}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) { return { content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true }; }
  }

  private async handleFilesystemRead(args: FileSystemToolArgs): Promise<unknown> { const content = this.fileSystem.get(args.path); if (content === undefined) throw new Error(`File not found: ${args.path}`); return { path: args.path, content }; }
  private async handleFilesystemWrite(args: FileSystemToolArgs): Promise<unknown> { this.fileSystem.set(args.path, args.content || ""); return { path: args.path, success: true }; }
  private async handleFilesystemList(args: FileSystemToolArgs): Promise<unknown> { const path = args.path || "/"; const entries: Array<{ name: string; type: "file" | "directory" }> = []; for (const [key] of this.fileSystem) { if (key.startsWith(path) && key !== path) { const relative = key.slice(path.length).replace(/^\//, ""); const parts = relative.split("/"); if (parts.length === 1 || (parts.length === 2 && parts[1] === "")) entries.push({ name: parts[0], type: "file" }); } } return { path, entries }; }
  private async handleFilesystemDelete(args: FileSystemToolArgs): Promise<unknown> { const deleted = this.fileSystem.delete(args.path); return { path: args.path, deleted }; }
  private async handleFilesystemMove(args: FileSystemToolArgs): Promise<unknown> { const content = this.fileSystem.get(args.path); if (content === undefined) throw new Error(`Source not found: ${args.path}`); this.fileSystem.delete(args.path); this.fileSystem.set(args.targetPath!, content); return { oldPath: args.path, newPath: args.targetPath, success: true }; }
  private async handleFilesystemSearch(args: FileSystemToolArgs): Promise<unknown> { const regex = new RegExp(args.pattern || ""); const results: Array<{ path: string }> = []; for (const [key] of this.fileSystem) { if (regex.test(key)) results.push({ path: key }); } return { pattern: args.pattern, results }; }
  private async handleTerminalExec(args: TerminalToolArgs): Promise<unknown> { if (!this.sandboxManager) throw new Error("Sandbox manager not configured"); const session = this.sandboxManager.getSession(args.sessionId!); if (!session) throw new Error(`Session not found: ${args.sessionId}`); return { sessionId: args.sessionId, command: args.command, args: args.args, output: "Command executed (simulated)", exitCode: 0 }; }
  private async handleTerminalSpawn(args: TerminalToolArgs): Promise<unknown> { if (!this.sandboxManager) throw new Error("Sandbox manager not configured"); const session = this.sandboxManager.getSession(args.sessionId!); if (!session) throw new Error(`Session not found: ${args.sessionId}`); return { sessionId: args.sessionId, command: args.command, args: args.args, processId: uuidv4(), status: "running" }; }
  private async handleSandboxCreate(args: SandboxToolArgs): Promise<unknown> { if (!this.sandboxManager) throw new Error("Sandbox manager not configured"); const session = await this.sandboxManager.createSession(args.userId!, args.projectId!, args.config); return { sessionId: session.id, status: "created" }; }
  private async handleSandboxStart(args: SandboxToolArgs): Promise<unknown> { if (!this.sandboxManager) throw new Error("Sandbox manager not configured"); await this.sandboxManager.startSession(args.sessionId!); return { sessionId: args.sessionId, status: "running" }; }
  private async handleSandboxStop(args: SandboxToolArgs): Promise<unknown> { if (!this.sandboxManager) throw new Error("Sandbox manager not configured"); await this.sandboxManager.stopSession(args.sessionId!); return { sessionId: args.sessionId, status: "stopped" }; }
  private async handleSandboxLogs(args: SandboxToolArgs): Promise<unknown> { if (!this.sandboxManager) throw new Error("Sandbox manager not configured"); return { sessionId: args.sessionId, logs: [] }; }
  private async handleGitStatus(args: GitToolArgs): Promise<unknown> { return { sessionId: args.sessionId, status: "clean", staged: [], unstaged: [], untracked: [] }; }
  private async handleGitCommit(args: GitToolArgs): Promise<unknown> { return { sessionId: args.sessionId, message: args.message, hash: uuidv4() }; }
  private async handleGitPush(args: GitToolArgs): Promise<unknown> { return { sessionId: args.sessionId, remote: args.remote || "origin", branch: args.branch || "main", success: true }; }
  private async handleGitPull(args: GitToolArgs): Promise<unknown> { return { sessionId: args.sessionId, remote: args.remote || "origin", branch: args.branch || "main", success: true }; }
  private async handleGitHistory(args: GitToolArgs): Promise<unknown> { return { sessionId: args.sessionId, commits: [] }; }

  private async handleListResources(request: MCPListResourcesRequest): Promise<MCPListResourcesResult> { const resources: MCPResource[] = [ { uri: "emergent://filesystem", name: "Virtual File System", description: "Access to the virtual file system", mimeType: "application/json" }, { uri: "emergent://sandbox", name: "Sandbox Sessions", description: "Active sandbox sessions", mimeType: "application/json" }, { uri: "emergent://git", name: "Git Repositories", description: "Git repository information", mimeType: "application/json" } ]; return { resources }; }
  private async handleReadResource(request: MCPReadResourceRequest): Promise<MCPResourceContent> { if (request.uri === "emergent://filesystem") return { uri: request.uri, mimeType: "application/json", text: JSON.stringify({ files: Array.from(this.fileSystem.keys()) }, null, 2) }; if (request.uri === "emergent://sandbox") return { uri: request.uri, mimeType: "application/json", text: JSON.stringify({ sessions: Array.from(this.sessions.values()) }, null, 2) }; if (request.uri === "emergent://git") return { uri: request.uri, mimeType: "application/json", text: JSON.stringify({ repositories: [] }, null, 2) }; throw new Error(`Resource not found: ${request.uri}`); }

  private handleSSE(req: IncomingMessage, res: ServerResponse): void { this.sseTransport = new SSEServerTransport("/messages", res); this.mcpServer.server.connect(this.sseTransport); }
  private handleWSConnection(ws: WebSocket, req: IncomingMessage): void { const sessionId = uuidv4(); const session: MCPSession = { id: sessionId, clientId: uuidv4(), capabilities: {}, createdAt: new Date(), lastActivity: new Date() }; this.sessions.set(sessionId, session); this.emit("sessionCreated", session); ws.on("message", async (data: Buffer) => { try { const message = JSON.parse(data.toString()) as MCPMessage; session.lastActivity = new Date(); if (message.method) { const response = await this.handleMCPMessage(sessionId, message); if (message.id !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response })); } } catch (error) { this.emit("error", error as Error, sessionId); } }); ws.on("close", () => this.closeSession(sessionId)); ws.on("error", (error) => this.emit("error", error, sessionId)); }
  private async handleMCPMessage(sessionId: string, message: MCPMessage): Promise<unknown> { return {}; }
  private async closeSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); this.emit("sessionClosed", sessionId); }
  private startSessionCleanup(): void { this.sessionCleanupTimer = setInterval(() => { const now = Date.now(); for (const [sessionId, session] of this.sessions.entries()) { if (now - session.lastActivity.getTime() > this.config.sessionTimeout) this.closeSession(sessionId); } }, 60000); }
}

export interface SandboxManager { createSession(userId: string, projectId: string, config?: Record<string, unknown>): Promise<{ id: string; status: string }>; startSession(sessionId: string): Promise<void>; stopSession(sessionId: string): Promise<void>; getSession(sessionId: string): { id: string; status: string } | undefined; }
export function createMCPServer(config?: Partial<MCPConfig>): MCPServer { return new MCPServer(config); }