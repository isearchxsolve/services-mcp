import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import * as http from "http";
import { z } from "zod";
import {
  MCPConfig,
  MCPServer,
  MCPRequest,
  MCPResponse,
  MCPError,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPInitializeParams,
  MCPInitializeResult,
  MCPServerCapabilities,
  MCPResourceContent,
  MCPPromptResult,
  MCPPromptMessage
} from "./types";

interface ExtendedWebSocket extends WebSocket {
  sessionId: string;
  initialized: boolean;
  isAlive: boolean;
}

const RequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional()
});

export class MCPServerImpl extends EventEmitter implements MCPServer {
  private config: Required<MCPConfig>;
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private sessions: Map<string, ExtendedWebSocket> = new Map();
  private tools: Map<string, { tool: MCPTool; handler: (params: unknown) => Promise<unknown> }> = new Map();
  private resources: Map<string, { resource: MCPResource; handler: (uri: string) => Promise<{ contents: MCPResourceContent[] }> }> = new Map();
  private prompts: Map<string, { prompt: MCPPrompt; handler: (args: Record<string, string>) => Promise<MCPPromptResult> }> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private started = false;

  private readonly capabilities: MCPServerCapabilities = {
    tools: true,
    resources: true,
    prompts: true,
    logging: true
  };

  constructor(config: MCPConfig) {
    super();
    this.config = {
      port: config.port,
      host: config.host || "0.0.0.0",
      path: config.path || "/mcp",
      allowedOrigins: config.allowedOrigins || ["*"]
    };
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.server = http.createServer();
    this.wss = new WebSocketServer({
      server: this.server,
      path: this.config.path
    });

    this.wss.on("connection", (ws: ExtendedWebSocket, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on("error", (error) => {
      this.emit("error", error);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.started = true;
        this.startHeartbeat();
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const [sessionId, ws] of this.sessions) {
      ws.close(1001, "Server shutting down");
    }
    this.sessions.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.started = false;
  }

  private handleConnection(ws: ExtendedWebSocket, req: http.IncomingMessage): void {
    const sessionId = uuidv4();
    ws.sessionId = sessionId;
    ws.initialized = false;
    ws.isAlive = true;

    this.sessions.set(sessionId, ws);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (data: Buffer) => {
      await this.handleMessage(sessionId, data);
    });

    ws.on("close", () => {
      this.sessions.delete(sessionId);
    });

    ws.on("error", (error) => {
      this.emit("error", error);
    });
  }

  private async handleMessage(sessionId: string, data: Buffer): Promise<void> {
    const ws = this.sessions.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      const parsed = JSON.parse(data.toString());
      const request = RequestSchema.parse(parsed) as MCPRequest;
      
      const response = await this.processRequest(request, sessionId);
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    } catch (error) {
      const errorResponse: MCPResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
          data: (error as Error).message
        }
      };
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(errorResponse));
      }
    }
  }

  private async processRequest(request: MCPRequest, sessionId: string): Promise<MCPResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case "initialize":
          return await this.handleInitialize(id, params as MCPInitializeParams);
        
        case "tools/list":
          return this.handleToolsList(id);
        
        case "tools/call":
          return await this.handleToolCall(id, params);
        
        case "resources/list":
          return this.handleResourcesList(id);
        
        case "resources/read":
          return await this.handleResourceRead(id, params);
        
        case "prompts/list":
          return this.handlePromptsList(id);
        
        case "prompts/get":
          return await this.handlePromptGet(id, params);
        
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`
            }
          };
      }
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: "Internal error",
          data: (error as Error).message
        }
      };
    }
  }

  private async handleInitialize(id: string | number, params: MCPInitializeParams): Promise<MCPResponse> {
    const result: MCPInitializeResult = {
      protocolVersion: "2024-11-05",
      capabilities: this.capabilities,
      serverInfo: {
        name: "emergent-mcp",
        version: "1.0.0"
      }
    };

    return {
      jsonrpc: "2.0",
      id,
      result
    };
  }

  private handleToolsList(id: string | number): MCPResponse {
    const tools = Array.from(this.tools.values()).map(t => t.tool);
    return {
      jsonrpc: "2.0",
      id,
      result: { tools }
    };
  }

  private async handleToolCall(id: string | number, params?: unknown): Promise<MCPResponse> {
    const toolParams = params as { name: string; arguments?: unknown };
    if (!toolParams?.name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid tool call parameters" }
      };
    }

    const toolEntry = this.tools.get(toolParams.name);
    if (!toolEntry) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool not found: ${toolParams.name}` }
      };
    }

    try {
      const result = await toolEntry.handler(toolParams.arguments || {});
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] }
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: (error as Error).message }
      };
    }
  }

  private handleResourcesList(id: string | number): MCPResponse {
    const resources = Array.from(this.resources.values()).map(r => r.resource);
    return {
      jsonrpc: "2.0",
      id,
      result: { resources }
    };
  }

  private async handleResourceRead(id: string | number, params?: unknown): Promise<MCPResponse> {
    const readParams = params as { uri: string };
    if (!readParams?.uri) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid resource read parameters" }
      };
    }

    const resourceEntry = this.resources.get(readParams.uri);
    if (!resourceEntry) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Resource not found: ${readParams.uri}` }
      };
    }

    try {
      const result = await resourceEntry.handler(readParams.uri);
      return {
        jsonrpc: "2.0",
        id,
        result
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: (error as Error).message }
      };
    }
  }

  private handlePromptsList(id: string | number): MCPResponse {
    const prompts = Array.from(this.prompts.values()).map(p => p.prompt);
    return {
      jsonrpc: "2.0",
      id,
      result: { prompts }
    };
  }

  private async handlePromptGet(id: string | number, params?: unknown): Promise<MCPResponse> {
    const promptParams = params as { name: string; arguments?: Record<string, string> };
    if (!promptParams?.name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid prompt get parameters" }
      };
    }

    const promptEntry = this.prompts.get(promptParams.name);
    if (!promptEntry) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Prompt not found: ${promptParams.name}` }
      };
    }

    try {
      const result = await promptEntry.handler(promptParams.arguments || {});
      return {
        jsonrpc: "2.0",
        id,
        result
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: (error as Error).message }
      };
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [sessionId, ws] of this.sessions) {
        if (ws.isAlive === false) {
          ws.terminate();
          this.sessions.delete(sessionId);
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
  }

  // Tool registration
  registerTool(tool: MCPTool, handler: (params: unknown) => Promise<unknown>): void {
    this.tools.set(tool.name, { tool, handler });
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  // Resource registration
  registerResource(
    resource: MCPResource, 
    handler: (uri: string) => Promise<{ contents: MCPResourceContent[] }>
  ): void {
    this.resources.set(resource.uri, { resource, handler });
  }

  unregisterResource(uri: string): void {
    this.resources.delete(uri);
  }

  // Prompt registration
  registerPrompt(
    prompt: MCPPrompt, 
    handler: (args: Record<string, string>) => Promise<MCPPromptResult>
  ): void {
    this.prompts.set(prompt.name, { prompt, handler });
  }

  unregisterPrompt(name: string): void {
    this.prompts.delete(name);
  }
}

export function createMCPServer(config: MCPConfig): MCPServer {
  return new MCPServerImpl(config);
}
