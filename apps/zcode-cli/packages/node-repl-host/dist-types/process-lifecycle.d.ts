/**
 * Synchronous errors of a REPL cell are caught by NodeReplSession, but fire-and-forget
 * asynchronous errors (an un-awaited tab.* call being rejected when a turn is interrupted)
 * punch through the whole server process under Node's default policy. Once the child dies,
 * Browser Use is unavailable in that session ever after. Here asynchronous errors are degraded
 * to stderr log lines: the runtime state is preserved and the protocol's stdout is unaffected.
 *
 * After the parent process exits, stderr reports EPIPE. The old handler wrote the EPIPE stack
 * back to that same stderr, forming an endless EPIPE -> uncaughtException -> stderr.write ->
 * EPIPE loop. A closed output pipe means the MCP client is unreachable, so shutdown must be
 * entered directly and diagnostics must not keep being written.
 */
export declare function installNodeReplProcessGuards(input: {
    onOutputClosed: (error: Error) => void;
    process: Pick<NodeJS.Process, "on">;
    writeStderr: (text: string) => void;
}): void;
export declare function installNodeReplShutdownTriggers(input: {
    process: Pick<NodeJS.Process, "once">;
    shutdown: () => void;
    stdin: Pick<NodeJS.ReadStream, "once">;
}): void;
export declare function isDirectMcpEntrypoint(importMetaUrl: string, argvPath: string | undefined): Promise<boolean>;
//# sourceMappingURL=process-lifecycle.d.ts.map