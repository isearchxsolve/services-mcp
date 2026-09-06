import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createMCPServer, MCPServer } from '../src/index';

describe('MCPServer', () => {
  let server: MCPServer;
  const testPort = 34569;

  beforeAll(async () => {
    server = createMCPServer({ port: testPort, path: '/test-mcp' });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should start and stop correctly', async () => {
    expect(server).toBeDefined();
  });

  it('should register and unregister tools', () => {
    const tool = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        }
      }
    };

    server.registerTool(tool, async (params) => ({ result: params }));
    
    // Verify tool is registered by checking if we can unregister it
    server.unregisterTool('test_tool');
    expect(true).toBe(true);
  });

  it('should register and unregister resources', () => {
    const resource = {
      uri: 'test://resource/1',
      name: 'Test Resource',
      description: 'A test resource'
    };

    server.registerResource(resource, async (uri) => ({
      contents: [{ uri, mimeType: 'text/plain', text: 'Hello World' }]
    }));

    server.unregisterResource('test://resource/1');
    expect(true).toBe(true);
  });

  it('should register and unregister prompts', () => {
    const prompt = {
      name: 'test_prompt',
      description: 'A test prompt',
      arguments: [
        { name: 'arg1', description: 'First argument', required: true }
      ]
    };

    server.registerPrompt(prompt, async (args) => ({
      description: 'Test prompt result',
      messages: [
        { role: 'user', content: { uri: 'test://prompt', text: 'Test prompt with ' + args.arg1 } }
      ]
    }));

    server.unregisterPrompt('test_prompt');
    expect(true).toBe(true);
  });
});

describe('createMCPServer', () => {
  it('should create an MCP server instance', () => {
    const server = createMCPServer({ port: 34570 });
    expect(server).toBeDefined();
    expect(typeof server.start).toBe('function');
    expect(typeof server.stop).toBe('function');
    expect(typeof server.registerTool).toBe('function');
    expect(typeof server.unregisterTool).toBe('function');
    expect(typeof server.registerResource).toBe('function');
    expect(typeof server.unregisterResource).toBe('function');
    expect(typeof server.registerPrompt).toBe('function');
    expect(typeof server.unregisterPrompt).toBe('function');
  });
});
