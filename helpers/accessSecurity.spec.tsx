import { accessSecurity } from "./accessSecurity";

describe("accessSecurity", () => {
  it("hashes opaque tokens with SHA-256 hex", () => {
    expect(accessSecurity.sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("accepts only 32-byte base64url token shape", () => {
    expect(accessSecurity.isOpaqueToken("A".repeat(43))).toBe(true);
    expect(accessSecurity.isOpaqueToken("A".repeat(42))).toBe(false);
    expect(accessSecurity.isOpaqueToken("A".repeat(43) + "=")).toBe(false);
    expect(accessSecurity.isOpaqueToken("A".repeat(42) + "+")).toBe(false);
    expect(accessSecurity.isOpaqueToken("A".repeat(42) + "B")).toBe(false);
  });

  it("allows only the designated admin identity as host", () => {
    expect(accessSecurity.isHostIdentity(7, 7, "admin")).toBe(true);
    expect(accessSecurity.isHostIdentity(null, 7, "admin")).toBe(false);
    expect(accessSecurity.isHostIdentity(8, 7, "admin")).toBe(false);
    expect(accessSecurity.isHostIdentity(7, 7, "user")).toBe(false);
  });

  it("keeps guest links active until revoked, even after legacy expiry dates", () => {
    const now = new Date("2126-09-23T12:00:00.000Z");

    // Link expiry is intentionally absent from the policy; legacy expiresAt values do not block access.
    expect(accessSecurity.isGuestLinkActive(null)).toBe(true);
    expect(accessSecurity.isGuestLinkActive(now)).toBe(false);
  });

  it("requires guest sessions to be valid, unexpired, and linked to an unrevoked link", () => {
    const now = new Date("2126-09-23T12:00:00.000Z");
    expect(accessSecurity.isGuestSessionActive(
      "2126-09-23T23:00:00.000Z", null, now,
    )).toBe(true);
    expect(accessSecurity.isGuestSessionActive(
      "2126-09-22T23:00:00.000Z", null, now,
    )).toBe(false);
    expect(accessSecurity.isGuestSessionActive(
      "2126-09-23T12:00:00.000Z", null, now,
    )).toBe(false);
    expect(accessSecurity.isGuestSessionActive(
      "invalid timestamp", null, now,
    )).toBe(false);
    expect(accessSecurity.isGuestSessionActive(
      "2126-09-23T23:00:00.000Z", now, now,
    )).toBe(false);
  });

  it("makes bootstrap one-time, owner-bound, unexpired, and hash-bound", () => {
    const now = new Date("2026-09-23T12:00:00.000Z");
    const tokenHash = accessSecurity.sha256Hex("bootstrap-token");
    expect(accessSecurity.isBootstrapAvailable(
      null, null, "2026-09-24T12:00:00.000Z", tokenHash, tokenHash, now,
    )).toBe(true);
    expect(accessSecurity.isBootstrapAvailable(
      7, null, "2026-09-24T12:00:00.000Z", tokenHash, tokenHash, now,
    )).toBe(false);
    expect(accessSecurity.isBootstrapAvailable(
      null, now, "2026-09-24T12:00:00.000Z", tokenHash, tokenHash, now,
    )).toBe(false);
    expect(accessSecurity.isBootstrapAvailable(
      null, null, "2026-09-22T12:00:00.000Z", tokenHash, tokenHash, now,
    )).toBe(false);
    expect(accessSecurity.isBootstrapAvailable(
      null, null, "2026-09-24T12:00:00.000Z", tokenHash, accessSecurity.sha256Hex("wrong"), now,
    )).toBe(false);
  });

  it("requires exact request origin and rejects missing or lookalike origins", () => {
    const same = new Request("https://cellar.example/access", {
      headers: { origin: "https://cellar.example" },
    });
    const lookalike = new Request("https://cellar.example/access", {
      headers: { origin: "https://cellar.example.attacker.test" },
    });
    const missing = new Request("https://cellar.example/access");

    expect(accessSecurity.isSameOrigin(same)).toBe(true);
    expect(accessSecurity.isSameOrigin(lookalike)).toBe(false);
    expect(accessSecurity.isSameOrigin(missing)).toBe(false);
  });

  it("rejects ambiguous duplicate cookies and preserves equals in values", () => {
    const single = new Request("https://cellar.example", {
      headers: { cookie: "other=x; cellar_guest_session=a%3Db" },
    });
    const duplicate = new Request("https://cellar.example", {
      headers: { cookie: "cellar_guest_session=one; cellar_guest_session=two" },
    });

    expect(accessSecurity.cookieValue(single, "cellar_guest_session")).toBe("a=b");
    expect(accessSecurity.cookieValue(duplicate, "cellar_guest_session")).toBeNull();
  });
});
