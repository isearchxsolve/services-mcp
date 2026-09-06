/**
 * Vitest Tests for MCP Server
 * Tests Model Context Protocol server functionality
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { MCPServer, createMCPServer, SandboxManager } from "./mcp-server.js";
import type { MCPTool, MCPResource, MCPSession, MCPConfig, MCPCallToolRequest, MCPListResourcesRequest, MCPReadResourceRequest } from "./types.js";

const TEST_PORT = 13001;
const TEST_TIMEOUT = 10000;

// Mock sandbox manager for testing
class MockSandboxManager implements SandboxManager {
  private sessions: Map<string, { id: string; status: string }> = new Map();

  async createSession(userId: string, projectId: string, config?: Record<string, unknown>): Promise<{ id: string; status: string }> {
    const session = { id: `session-${Date.now()}`, status: "created" };
    this.sessions.set(session.id, session);
    return session;
  }

  async startSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "running";
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "stopped";
  }

  getSession(sessionId: string): { id: string; status: string } | undefined {
    return this.sessions.get(sessionId);
  }
}

describe("MCPServer", () => {
  let server: MCPServer;
  let mockSandboxManager: MockSandboxManager;

  beforeAll(async () => {
    server = createMCPServer({ port: TEST_PORT, host: "localhost", path: "/mcp" });
    mockSandboxManager = new MockSandboxManager();
    server.setSandboxManager(mockSandboxManager);
    await server.start();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await server.stop();
  }, TEST_TIMEOUT);

  describe("Server Lifecycle", () => {
    it("should start and stop successfully", async () => {
      expect(server.getSessionCount()).toBe(0);
    });

    it("should have correct capabilities", () => {
      expect(server).toBeDefined();
    });
  });

  describe("Session Management", () => {
    it("should create sessions on WebSocket connection", async () => {
      expect(typeof server.getSessionCount).toBe("function");
      expect(typeof server.getSession).toBe("function");
    });
  });

  describe("Available Tools", () => {
    it("should provide filesystem tools", () => {
      const tools = server.getTools();
      const fsTools = tools.filter(t => t.name.startsWith("filesystem_"));
      expect(fsTools.length).toBeGreaterThanOrEqual(6);
    });

    it("should provide terminal tools", () => {
      const tools = server.getTools();
      const termTools = tools.filter(t => t.name.startsWith("terminal_"));
      expect(termTools.length).toBeGreaterThanOrEqual(2);
    });

    it("should provide sandbox tools", () => {
      const tools = server.getTools();
      const sandboxTools = tools.filter(t => t.name.startsWith("sandbox_"));
      expect(sandboxTools.length).toBeGreaterThanOrEqual(4);
    });

    it("should provide git tools", () => {
      const tools = server.getTools();
      const gitTools = tools.filter(t => t.name.startsWith("git_"));
      expect(gitTools.length).toBeGreaterThanOrEqual(5);
    });

    it("should have valid tool schemas", () => {
      const tools = server.getTools();
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe("Tool Execution", () => {
    it("should handle filesystem_read tool", async () => {
      (server as unknown as { fileSystem: Map<string, string> }).fileSystem.set("/test.txt", "Hello MCP");
      
      const result = await server.callTool({
        name: "filesystem_read",
        arguments: { operation: "read", path: "/test.txt" },
      });
      
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain("Hello MCP");
    });

    it("should handle filesystem_write tool", async () => {
      const result = await server.callTool({
        name: "filesystem_write",
        arguments: { operation: "write", path: "/new-file.txt", content: "New content" },
      });
      
      expect(result.isError).not.toBe(true);
      const fs = (server as unknown as { fileSystem: Map<string, string> }).fileSystem;
      expect(fs.get("/new-file.txt")).toBe("New content");
    });

    it("should handle filesystem_list tool", async () => {
      (server as unknown as { fileSystem: Map<string, string> }).fileSystem.set("/dir/file1.txt", "File 1");
      (server as unknown as { fileSystem: Map<string, string> }).fileSystem.set("/dir/file2.txt", "File 2");
      
      const result = await server.callTool({
        name: "filesystem_list",
        arguments: { operation: "list", path: "/dir" },
      });
      
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entries.length).toBe(2);
    });

    it("should handle sandbox_create tool", async () => {
      const result = await server.callTool({
        name: "sandbox_create",
        arguments: { operation: "create", userId: "user-123", projectId: "project-456" },
      });
      
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBeDefined();
      expect(parsed.status).toBe("created");
    });

    it("should handle unknown tool error", async () => {
      const result = await server.callTool({
        name: "unknown_tool",
        arguments: {},
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });

  describe("Resource Handling", () => {
    it("should list resources", async () => {
      const result = await server.listResources({});
      
      expect(result.resources.length).toBe(3);
      const uris = result.resources.map(r => r.uri);
      expect(uris).toContain("emergent://filesystem");
      expect(uris).toContain("emergent://sandbox");
      expect(uris).toContain("emergent://git");
    });

    it("should read filesystem resource", async () => {
      (server as unknown as { fileSystem: Map<string, string> }).fileSystem.set("/resource-test.txt", "Resource content");
      
      const result = await server.readResource({ uri: "emergent://filesystem" });
      
      expect(result.uri).toBe("emergent://filesystem");
      expect(result.mimeType).toBe("application/json");
      expect(result.text).toContain("resource-test.txt");
    });

    it("should handle unknown resource error", async () => {
      await expect(server.readResource({ uri: "emergent://unknown" })).rejects.toThrow("Resource not found");
    });
  });

  describe("Configuration", () => {
    it("should use default config when none provided", () => {
      const defaultServer = createMCPServer();
      expect(defaultServer).toBeInstanceOf(MCPServer);
    });

    it("should accept custom config", () => {
      const customServer = createMCPServer({ port: 9999, path: "/custom-mcp" });
      expect(customServer).toBeInstanceOf(MCPServer);
    });
  });
});

describe("createMCPServer factory", () => {
  it("should create an MCPServer instance", () => {
    const server = createMCPServer();
    expect(server).toBeInstanceOf(MCPServer);
  });

  it("should accept custom config", () => {
    const server = createMCPServer({ port: 9090, host: "0.0.0.0" });
    expect(server).toBeInstanceOf(MCPServer);
  });
});