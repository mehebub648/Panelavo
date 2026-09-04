import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  request: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  resolve4: mocks.resolve4,
  resolve6: mocks.resolve6,
}));
vi.mock("node:https", () => ({ request: mocks.request }));

import { postFleetJson } from "./network";

function response(statusCode: number, chunks: Buffer[]) {
  mocks.request.mockImplementation((options, callback) => {
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error: Error) => void;
    };
    request.destroy = (error) => request.emit("error", error);
    request.end = () =>
      queueMicrotask(() => {
        const message = new EventEmitter() as EventEmitter & {
          statusCode: number;
        };
        message.statusCode = statusCode;
        callback(message);
        for (const chunk of chunks) message.emit("data", chunk);
        message.emit("end");
      });
    return request;
  });
}

describe("Fleet HTTPS transport", () => {
  beforeEach(() => {
    mocks.resolve4.mockResolvedValue(["1.1.1.1"]);
    mocks.resolve6.mockResolvedValue([]);
    mocks.request.mockReset();
  });

  it("pins a validated DNS answer and refuses redirects", async () => {
    response(302, [Buffer.from("redirect")]);
    await expect(
      postFleetJson(
        "https://node.example.com",
        "/api/federation/v1/execute",
        {},
      ),
    ).rejects.toThrow(/rejected/);
    const options = mocks.request.mock.calls[0][0];
    expect(options.hostname).toBe("node.example.com");
    expect(options.port).toBe(443);
    expect(options.headers.cookie).toBeUndefined();
    await new Promise<void>((resolve, reject) =>
      options.lookup(
        "node.example.com",
        {},
        (error: Error | null, address: string) =>
          error ? reject(error) : (expect(address).toBe("1.1.1.1"), resolve()),
      ),
    );
  });

  it("rejects oversized requests and responses", async () => {
    await expect(
      postFleetJson("https://node.example.com", "/api/federation/v1/execute", {
        data: "x".repeat(8 * 1024 * 1024),
      }),
    ).rejects.toThrow(/too large/i);
    response(200, [Buffer.alloc(8 * 1024 * 1024 + 1)]);
    await expect(
      postFleetJson(
        "https://node.example.com",
        "/api/federation/v1/execute",
        {},
      ),
    ).rejects.toThrow(/too large/i);
  });

  it("turns a bounded socket timeout into a remote error", async () => {
    mocks.request.mockImplementation(() => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error: Error) => void;
      };
      request.destroy = (error) => request.emit("error", error);
      request.end = () => queueMicrotask(() => request.emit("timeout"));
      return request;
    });
    await expect(
      postFleetJson(
        "https://node.example.com",
        "/api/federation/v1/execute",
        {},
        5,
      ),
    ).rejects.toThrow(/timed out/i);
  });
});
