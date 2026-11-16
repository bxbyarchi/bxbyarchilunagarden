import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, validatePassword, normalizeLogin } from "../lib/passwords";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("salts: the same password hashes differently each time", async () => {
    expect(await hashPassword("same-password")).not.toBe(await hashPassword("same-password"));
  });

  it("rejects missing or malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$abc")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$c2FsdA==$")).toBe(false);
  });
});

describe("validatePassword / normalizeLogin", () => {
  it("enforces a minimum length", () => {
    expect(validatePassword("short")).not.toBeNull();
    expect(validatePassword(undefined)).not.toBeNull();
    expect(validatePassword("long-enough")).toBeNull();
  });

  it("normalises logins and rejects spaces / too short", () => {
    expect(normalizeLogin("  Povar1 ")).toBe("povar1");
    expect(normalizeLogin("Ivan@Example.com")).toBe("ivan@example.com");
    expect(normalizeLogin("a")).toBeNull();
    expect(normalizeLogin("two words")).toBeNull();
    expect(normalizeLogin(42)).toBeNull();
  });
});
