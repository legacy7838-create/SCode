import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import {
  getLegacyTaskSessionSnapshotPath,
  setDataBaseDir,
} from "../src/paths.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";

const meta = {
  taskId: "wrapper-example",
  traceId: "trace-example",
  title: "Imported example",
  workspacePath: "/example/workspace",
  createdAt: 1,
  updatedAt: 2,
  mode: "build" as const,
  provider: "glm" as const,
};

// NOTE: The former "opening the task index leaves retired ACP IDs and user rows untouched" test
// (which seeded a foreign column via `node:sqlite` and asserted the Rust TaskIndexRepo preserved it
// on reopen) was retired together with `node:sqlite`. That schema-preservation property is now
// enforced directly by the Rust crate: `bootstrap_preserves_foreign_column_and_row_on_reopen` in
// packages/desktop/zcode-db/src/migrations.rs. The DB path is Rust-only; there is no JS fallback.

test("missing sessions report the owner error even when a valid ACP snapshot exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-acp-snapshot-"));
  setDataBaseDir(dir);
  const path = getLegacyTaskSessionSnapshotPath(meta.workspacePath, meta.taskId);
  const snapshot = parseLegacyTaskSessionFile({ meta, messages: [], toolCalls: [] });
  await mkdir(dirname(path), { recursive: true });
  const content = JSON.stringify(snapshot);
  await writeFile(path, content);
  const ownerError = new Error(`Session not found: ${meta.taskId}`);
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async resumeSession() {
        throw ownerError;
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      await assert.rejects(
        service.getTaskSnapshot({ ...meta, clientMode }),
        (error) => error === ownerError,
      );
    }
    assert.equal(await readFile(path, "utf8"), content);
  } finally {
    service.disposeAll();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("current session recovery preserves Desktop and replayable projections", async () => {
  const snapshot = zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: meta.taskId,
      workspace: { workspacePath: meta.workspacePath, workspaceKey: meta.workspacePath },
      sessionKind: "interactive",
      title: meta.title,
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: meta.taskId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 4, stateRevision: 3, pendingRequestIds: [] },
    messages: [],
    slashCommands: [{ name: "compact", description: "Compact" }],
  });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const disposable = () => ({ dispose() {} });
  const resumed: unknown[] = [];
  const indexed: unknown[] = [];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async resumeSession(params: unknown) {
        resumed.push(params);
        return snapshot;
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      async syncTaskMeta(params: { meta: typeof meta }) {
        indexed.push(params.meta);
        return params.meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter() {
        return { fire() {} };
      },
      ensureSessionSubscription() {},
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    const desktop = await service.getTaskSnapshot({ ...meta, clientMode: "desktop-continuous" });
    const mobile = await service.getTaskSnapshot({ ...meta, clientMode: "web-remote-replayable" });
    assert.equal(desktop?.meta.taskId, meta.taskId);
    assert.equal(desktop?.meta.provider, "glm");
    assert.deepEqual(desktop?.slashCommands, snapshot.slashCommands);
    assert.equal(desktop?.runtime?.pendingElicitations, undefined);
    assert.deepEqual(mobile?.runtime?.pendingElicitations, []);
    assert.equal((await service.resumeTask(meta)).taskId, meta.taskId);
    assert.equal(resumed.length, 3);
    assert.equal(indexed.length, 3);
  } finally {
    service.disposeAll();
  }
});

test("current Provider configuration starts without an old config migration callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-provider-current-"));
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    await runtime.start();
    const config = await runtime.configService.read();
    assert.ok(config.zcodeBuiltinRevision);
    assert.deepEqual(config.personalProviderOrder, []);
    assert.deepEqual(config.personalProviders.toJSON(), []);
  } finally {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
