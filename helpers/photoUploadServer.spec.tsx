import {
  assertPhotoHead,
  assertPhotoReservationRateLimit,
  decidePhotoReservationReplay,
  photoHeadUrl,
  photoUploadRequestHash,
} from "./photoUploadPolicy";
import { schema as photoUploadSchema } from "../endpoints/cellar/photo-upload_POST.schema";

const validRequest = {
  operationId: "8fe4db3e-224a-4d3d-89e0-d6d651a15bf8",
  sizeBytes: 1024,
  contentType: "image/jpeg" as const,
};

describe("photo upload reservation contract", () => {
  it("accepts bounded JPEG, PNG and WebP metadata only", () => {
    expect(photoUploadSchema.parse(validRequest)).toEqual(validRequest);
    expect(photoUploadSchema.parse({ ...validRequest, contentType: "image/png" }).contentType).toBe("image/png");
    expect(photoUploadSchema.parse({ ...validRequest, contentType: "image/webp" }).contentType).toBe("image/webp");
    expect(() => photoUploadSchema.parse({ ...validRequest, sizeBytes: 0 })).toThrow();
    expect(() => photoUploadSchema.parse({ ...validRequest, sizeBytes: 5 * 1024 * 1024 + 1 })).toThrow();
    expect(() => photoUploadSchema.parse({ ...validRequest, contentType: "image/svg+xml" })).toThrow();
    expect(() => photoUploadSchema.parse({ ...validRequest, extraPath: "/_cdn/attacker.png" })).toThrow();
    expect(() => photoUploadSchema.parse({ ...validRequest, operationId: "not-a-uuid" })).toThrow();
  });

  it("resolves only an SDK-owned same-origin public CDN path for HEAD", () => {
    expect(photoHeadUrl("/_cdn/static/abc-1.png", "https://cellar.example/_api/cellar/photo-finalize"))
      .toBe("https://cellar.example/_cdn/static/abc-1.png");
    for (const path of [
      "https://attacker.example/image.jpg",
      "//attacker.example/image.jpg",
      "/_cdn/static/../private.png",
      "/_cdn/static/photo.png?redirect=https://attacker.example",
      "/_api/private/photo.png",
    ]) expect(() => photoHeadUrl(path, "https://cellar.example/_api/cellar/photo-finalize")).toThrow();
  });

  it("finalizes only exact nonredirected HEAD MIME and byte length", () => {
    const headers = new Headers({ "content-type": "image/jpeg; charset=binary", "content-length": "1024" });
    expect(() => assertPhotoHead({ status: 200, redirected: false, headers }, "image/jpeg", 1024)).not.toThrow();
    expect(() => assertPhotoHead({ status: 302, redirected: false, headers }, "image/jpeg", 1024)).toThrowError(/could not be verified/i);
    expect(() => assertPhotoHead({ status: 200, redirected: true, headers }, "image/jpeg", 1024)).toThrowError(/could not be verified/i);
    expect(() => assertPhotoHead({ status: 200, redirected: false, headers }, "image/png", 1024)).toThrowError(/does not match/i);
    expect(() => assertPhotoHead({ status: 200, redirected: false, headers }, "image/jpeg", 1023)).toThrowError(/does not match/i);
    expect(() => assertPhotoHead({ status: 200, redirected: false, headers: new Headers({ "content-type": "image/jpeg" }) }, "image/jpeg", 1024)).toThrowError(/does not match/i);
  });

  it("replays same-owner reservations, returns ready receipt, and rejects hash mismatch or expiry", () => {
    const hash = photoUploadRequestHash({ contentType: "image/jpeg", sizeBytes: 1024 });
    const expiresAt = new Date("2026-09-24T04:15:00.000Z");
    expect(decidePhotoReservationReplay({ status: "pending", requestHash: hash, photoPath: "/_cdn/static/a.jpg", expiresAt }, hash, Date.parse("2026-09-24T04:00:00.000Z")))
      .toEqual({ state: "pending" });
    expect(decidePhotoReservationReplay({ status: "ready", requestHash: hash, photoPath: "/_cdn/static/a.jpg", expiresAt: null }, hash))
      .toEqual({ state: "ready", photoPath: "/_cdn/static/a.jpg" });
    expect(() => decidePhotoReservationReplay({ status: "pending", requestHash: "other", photoPath: "/_cdn/static/a.jpg", expiresAt }, hash))
      .toThrowError(/different upload details/i);
    expect(() => decidePhotoReservationReplay({ status: "pending", requestHash: hash, photoPath: "/_cdn/static/a.jpg", expiresAt }, hash, expiresAt.getTime()))
      .toThrowError(/expired/i);
    expect(() => decidePhotoReservationReplay({ status: "pending", requestHash: hash, photoPath: null, expiresAt: new Date(Number.NaN) }, hash))
      .toThrowError(/expired/i);
  });

  it("enforces per-actor reservation limit", () => {
    expect(() => assertPhotoReservationRateLimit(19, 20)).not.toThrow();
    expect(() => assertPhotoReservationRateLimit(20, 20)).toThrowError(/too many/i);
    expect(() => assertPhotoReservationRateLimit(-1, 20)).toThrowError(/too many/i);
  });
});
