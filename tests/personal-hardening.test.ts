import { describe, expect, test } from "bun:test";
import { resolveTelemetryStatus } from "../src/telemetry/consent";
import { sendTelemetryPayload } from "../src/telemetry/sender";
import { createProfile } from "../src/telemetry/profile/client";
import { assertServerAuthConfig } from "../src/server/auth-cors";
import { requireManagementAuth } from "../src/server/management-auth";
import { runUpdate } from "../src/update/index";
import type { OcxConfig } from "../src/types";
import { readFileSync } from "node:fs";

describe("personal build security boundaries", () => {
  test("self-update fails before downloading or stopping the runtime", async () => {
    await expect(runUpdate()).rejects.toThrow("reviewed rebuild");
  });
  test("an existing opt-in or explicit environment opt-in cannot enable telemetry", () => {
    expect(resolveTelemetryStatus({ telemetry: { decision: "accepted", decidedAt: "2026-11-16T00:00:00Z", noticeShownAt: "2026-11-16T00:00:00Z" } }, { OCX_TELEMETRY: "1" }).effective).toBe(false);
    expect(resolveTelemetryStatus({}, {}).effective).toBe(false);
  });
  test("direct telemetry and profile callers cannot reach the network", async () => {
    let calls = 0;
    const fetch = (() => { calls++; throw new Error("network must not be called"); }) as typeof globalThis.fetch;
    const send = await sendTelemetryPayload({} as never, { fetch });
    const profile = await createProfile({} as never, { fetch });
    expect(send.ok).toBe(false);
    expect(profile.ok).toBe(false);
    expect(calls).toBe(0);
  });
  test("remote binds are refused even with a data-plane credential", () => {
    for (const hostname of ["0.0.0.0", "::", "192.168.1.2", "localhost", "example.com", ""]) {
      expect(() => assertServerAuthConfig({ hostname, apiKeys: [{ key: "test-only" }] } as OcxConfig)).toThrow("Personal build");
    }
    for (const hostname of [undefined, "127.0.0.1", "::1"]) {
      expect(() => assertServerAuthConfig({ hostname } as OcxConfig)).not.toThrow();
    }
    expect(() => assertServerAuthConfig({ runtimeRole: "hub" } as OcxConfig)).toThrow("Personal build");
    expect(() => assertServerAuthConfig({ client: {} } as OcxConfig)).toThrow("Personal build");
  });
  test("management still rejects an unauthenticated caller", () => {
    const state = { available: true as const, token: "test-only-admin-token", source: "environment" as const, sessions: new Map(), pairingGrants: new Map() };
    expect(requireManagementAuth(new Request("http://127.0.0.1:10100/api/config"), state)?.status).toBe(401);
  });
  test("desktop only trusts version-bound updates from the personal Windows channel", () => {
    const config = JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(config.plugins.updater.endpoints).toEqual([
      "https://github.com/abdomsisn/opencodex/releases/download/personal-windows-updates/latest.json",
    ]);
    expect(config.plugins.updater.requireSignedVersion).toBe(true);
    const upstream = JSON.parse(readFileSync(new URL("../desktop/src-tauri/update-trust-root.json", import.meta.url), "utf8"));
    expect(config.plugins.updater.pubkey).not.toBe(upstream.rootKeys[0].publicKey);
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.identifier).toBe("com.abdomsisn.opencodex.personal");
  });
});
