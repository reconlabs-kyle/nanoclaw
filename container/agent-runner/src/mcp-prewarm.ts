/**
 * MCP server prewarm utility.
 *
 * Claude Code SDK spawns mcpServers in background when query() starts but
 * does not block on their `initialize` handshake. If the agent calls an
 * mcp tool in the first turn (e.g. the email-briefing cron calling
 * mcp__gmail__search_emails right after prompt start), the server may still
 * be connecting and the call fails with "MCP servers are still connecting".
 *
 * This utility runs the initialize handshake against the MCP server before
 * query() is invoked, then kills the prewarm process. The cost is an OS
 * file cache warm-up + OAuth credential file validation. The SDK still
 * spawns its own fresh instance afterwards, but that second spawn is
 * materially faster because credentials and dependent modules are already
 * resident.
 */
import { spawn } from 'child_process';

export interface PrewarmResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

export async function prewarmMcpServer(
  name: string,
  command: string,
  args: string[],
  timeoutMs = 15000,
  log: (message: string) => void = () => {},
): Promise<PrewarmResult> {
  const startedAt = Date.now();

  return new Promise<PrewarmResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdoutBuffer = '';
    let stderr = '';
    let resolved = false;

    const finish = (result: Omit<PrewarmResult, 'durationMs'>) => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 1000).unref();
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref();

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          // Non-JSON output (warnings, deprecation notices) — ignore
          continue;
        }
        if (!msg || typeof msg !== 'object') continue;
        const m = msg as { id?: number; result?: unknown; error?: unknown };
        if (m.id === 1) {
          if (m.result) {
            // Send initialized notification to complete the handshake
            try {
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/initialized',
                }) + '\n',
              );
            } catch {
              /* server already gone; still counts as prewarmed */
            }
            clearTimeout(timer);
            log(`MCP ${name} initialize OK`);
            finish({ ok: true });
            return;
          }
          if (m.error) {
            clearTimeout(timer);
            finish({
              ok: false,
              error: `initialize error: ${JSON.stringify(m.error)}`,
            });
            return;
          }
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `spawn error: ${err.message}` });
    });

    child.on('exit', (code) => {
      if (resolved) return;
      clearTimeout(timer);
      finish({
        ok: false,
        error: `server exited early (code=${code}) stderr=${stderr.slice(-400)}`,
      });
    });

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nanoclaw-prewarm', version: '0.1.0' },
      },
    };
    try {
      child.stdin.write(JSON.stringify(initRequest) + '\n');
    } catch (err) {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `stdin write error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
