import test from "node:test";
import assert from "node:assert/strict";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import * as tracing from "@langfuse/tracing";
import { forceShutdownRuntime, getRuntime } from "../src/langfuse.ts";
import { startSessionObservation } from "../src/observation.ts";
import { clearAllSessionStates, state } from "../src/state.ts";

async function withFallback(run: (runtime: Awaited<ReturnType<typeof getRuntime>>, batches: any[][], visible: Set<string>) => Promise<void>) {
  const previousConfig = state.config;
  const previousProvider = tracing.getLangfuseTracerProvider();
  const originalFetch = globalThis.fetch;
  const provider = new BasicTracerProvider({ spanProcessors: [new LangfuseSpanProcessor({
    publicKey: "pk_test", secretKey: "sk_test",
    exporter: { export: (_spans, done) => done({ code: 0 }), shutdown: async () => {}, forceFlush: async () => {} },
  })] });
  const batches: any[][] = [];
  const visible = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      batches.push(JSON.parse(String(init.body)).batch);
      return new Response('{"successes":[],"errors":[]}', { status: 200 });
    }
    return new Response("{}", { status: url.endsWith("?limit=1") || visible.has(url.split("/").at(-1)!) ? 200 : 404 });
  };
  try {
    clearAllSessionStates();
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid" };
    const runtime = await getRuntime();
    // Keep the real SDK and wrapper, but drop OTel spans at the export boundary.
    tracing.setLangfuseTracerProvider(provider);
    await run(runtime, batches, visible);
  } finally {
    await forceShutdownRuntime();
    await provider.shutdown();
    tracing.setLangfuseTracerProvider(previousProvider);
    state.config = previousConfig;
    clearAllSessionStates();
    globalThis.fetch = originalFetch;
  }
}

test("REST fallback preserves standalone session trace attributes", async () => withFallback(async (runtime, batches) => {
  const observation = await startSessionObservation({
    runtime: async () => runtime,
    name: "session-compaction",
    asType: "span",
    body: { metadata: { reason: "manual" } },
    attributes: {
      sessionId: "child-session", userId: "user-1", traceName: "pi-session",
      metadata: { parentSessionId: "parent-session", sessionKind: "subagent" },
    },
  });
  observation.end();
  await forceShutdownRuntime();
  const trace = batches.flat().find(entry => entry.type === "trace-create")?.body;
  assert.equal(trace?.name, "pi-session");
  assert.equal(trace?.sessionId, "child-session");
  assert.equal(trace?.userId, "user-1");
  assert.equal(trace?.metadata.parentSessionId, "parent-session");
  assert.equal(trace?.metadata.sessionKind, "subagent");
  assert.equal(trace?.metadata.reason, "manual");
}));

test("REST fallback restores a missing later trace even when the first is visible", async () => withFallback(async (runtime, batches, visible) => {
  const roots = [];
  for (const sessionId of ["first-session", "second-session"]) {
    const root = await startSessionObservation({
      runtime: async () => runtime, name: "session-compaction", asType: "span",
      body: { metadata: { owner: sessionId } },
      attributes: { sessionId, traceName: "pi-session" },
    });
    roots.push(root);
    root.end();
  }
  visible.add(roots[0].traceId!);
  await forceShutdownRuntime();
  const entries = batches.flat();
  const traces = entries.filter(entry => entry.type === "trace-create").map(entry => entry.body);
  assert.deepEqual(traces.map(trace => [trace.id, trace.sessionId]), [[roots[1].traceId, "second-session"]]);
  assert.deepEqual(entries.filter(entry => entry.type !== "trace-create").map(entry => entry.body.traceId), [roots[1].traceId]);
}));

test("REST fallback restores every missing trace within one visibility window", async () => withFallback(async (runtime, batches) => {
  const roots = [];
  for (const sessionId of ["first-session", "second-session"]) {
    const root = await startSessionObservation({
      runtime: async () => runtime, name: "session-compaction", asType: "span",
      attributes: { sessionId, traceName: "pi-session" },
    });
    roots.push(root);
  }
  for (const [index, root] of roots.entries()) {
    root.update({ metadata: { owner: index }, output: `summary-${index}` });
    root.end();
  }
  await forceShutdownRuntime();
  const traces = batches.flat().filter(entry => entry.type === "trace-create").map(entry => entry.body);
  assert.deepEqual(traces.map(trace => [trace.id, trace.sessionId, trace.metadata.owner, trace.output]), [
    [roots[0].traceId, "first-session", 0, "summary-0"],
    [roots[1].traceId, "second-session", 1, "summary-1"],
  ]);
}));
