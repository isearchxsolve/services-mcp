export interface MCPConfig {
  port: number;
  host?: string;
  path?: string;
  allowedOrigins?: string[];
}

export interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: MCPError;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface MCPServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
}

export interface MCPClientCapabilities {
  roots?: boolean;
  sampling?: boolean;
}

export interface MCPInitializeParams {
  protocolVersion: string;
  capabilities: MCPClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface MCPServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Tool registration
  registerTool(tool: MCPTool, handler: (params: unknown) => Promise<unknown>): void;
  unregisterTool(name: string): void;
  
  // Resource registration
  registerResource(resource: MCPResource, handler: (uri: string) => Promise<{ contents: MCPResourceContent[] }>): void;
  unregisterResource(uri: string): void;
  
  // Prompt registration
  registerPrompt(prompt: MCPPrompt, handler: (args: Record<string, string>) => Promise<MCPPromptResult>): void;
  unregisterPrompt(name: string): void;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64
}

export interface MCPPromptResult {
  description?: string;
  messages: MCPPromptMessage[];
}

export interface MCPPromptMessage {
  role: "user" | "assistant";
  content: MCPResourceContent;
}

export function createMCPServer(config: MCPConfig): MCPServer;
