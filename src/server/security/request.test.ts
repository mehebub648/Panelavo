import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  assertSecureAuthenticationRequest,
  assertWriteRequest,
  clientKey,
  clearRateLimitStoreForTests,
  rateLimit,
} from "./request";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function writeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("https://panel.example.com/api/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "panel.example.com",
      origin: "https://panel.example.com",
      ...headers,
    },
  });
}

describe("write-request security", () => {
  afterEach(() => {
    clearRateLimitStoreForTests();
    vi.unstubAllEnvs();
  });

  it("accepts a same-host JSON write", () => {
    expect(() => assertWriteRequest(writeRequest())).not.toThrow();
  });

  it("does not let X-Forwarded-Host choose the CSRF comparison host", () => {
    expect(() =>
      assertWriteRequest(
        writeRequest({
          origin: "https://attacker.example",
          "x-forwarded-host": "attacker.example",
        }),
      ),
    ).toThrowError(/Cross-origin/);
  });

  it("uses the proxy-overwritten real address instead of a forwarding chain", () => {
    const request = writeRequest({
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
    });
    expect(clientKey(request)).toBe("203.0.113.7");
  });

  it("rejects an invalid proxy address instead of using attacker text as a key", () => {
    expect(clientKey(writeRequest({ "x-real-ip": "not-an-ip" }))).toBe(
      "local",
    );
  });

  it("persists throttling state so a process restart cannot reset attempts", () => {
    const directory = mkdtempSync(join(tmpdir(), "panelavo-rate-"));
    vi.stubEnv("PANEL_DATA_DIR", directory);
    try {
      rateLimit("login:203.0.113.7", 2, 60_000);
      clearRateLimitStoreForTests();
      rateLimit("login:203.0.113.7", 2, 60_000);
      expect(() => rateLimit("login:203.0.113.7", 2, 60_000)).toThrowError(
        /Too many attempts/,
      );
      expect(
        JSON.parse(readFileSync(join(directory, "rate-limits.json"), "utf8"))[
          "login:203.0.113.7"
        ].count,
      ).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects production sign-in when the public proxy is not using HTTPS", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertSecureAuthenticationRequest(writeRequest())).toThrowError(
      /only over HTTPS/,
    );
  });

  it("allows HTTPS and explicit loopback recovery sign-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      assertSecureAuthenticationRequest(
        writeRequest({ "x-forwarded-proto": "https" }),
      ),
    ).not.toThrow();
    expect(() =>
      assertSecureAuthenticationRequest(
        writeRequest({ host: "127.0.0.1:10443", origin: "http://127.0.0.1:10443" }),
      ),
    ).not.toThrow();
  });
});
