import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

let app: Express;
beforeAll(async () => {
  ({ default: app } = await import("../app"));
});

describe("CORS", () => {
  it("allows same-origin requests from any LAN address (Origin == Host)", async () => {
    const res = await request(app).get("/api/healthz").set("Host", "192.168.1.10:3000").set("Origin", "http://192.168.1.10:3000");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://192.168.1.10:3000");
  });

  it("gives a foreign origin no CORS headers, without a 500", async () => {
    const res = await request(app).get("/api/healthz").set("Host", "192.168.1.10:3000").set("Origin", "https://evil.example");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
