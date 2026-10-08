import { describe, expect, it } from "vitest";
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from "../src/password";

describe("password hashing", () => {
  it("verifies the right password only", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct hors", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("accepts hashes made by scripts/add-user.mjs", async () => {
    const fromScript = "pbkdf2-sha256$100000$A1WFs3tPSAHJOFpUO0IDcg$5mvICdlZ474Amv6YW3ptXPi-IdoSV-GaXG4UCxL1dWo";
    expect(await verifyPassword("script-made-pw", fromScript)).toBe(true);
    expect(await verifyPassword("other", fromScript)).toBe(false);
  });

  it("rejects malformed hashes and the dummy hash", async () => {
    for (const bad of ["", "plain", "md5$1$a$b", "pbkdf2-sha256$999999$AAAA$AAAA", "pbkdf2-sha256$0$AAAA$AAAA"]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
    expect(await verifyPassword("", DUMMY_HASH)).toBe(false);
  });

  it("enforces a minimum length", () => {
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem("long enough")).toBeNull();
  });
});
