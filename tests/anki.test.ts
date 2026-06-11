import { expect, test, describe, afterEach } from "bun:test";
import { uploadImage, addCard } from "../src/lib/anki.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("anki image upload path", () => {
  test("uploadImage POSTs raw bytes with image/* type, returns path", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ ok: true, path: "/tmp/anki-mcp-uploads/abc.png", bytes: 3 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const path = await uploadImage(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(path).toBe("/tmp/anki-mcp-uploads/abc.png");
    expect(captured!.url).toEndWith("/upload");
    expect(captured!.init.method).toBe("POST");
    expect((captured!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/jpeg",
    );
    // raw bytes body, not multipart/base64
    expect(captured!.init.body).toBeInstanceOf(Uint8Array);
  });

  test("uploadImage throws when server returns no path", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(uploadImage(new Uint8Array([1]))).rejects.toThrow("no path");
  });

  test("addCard forwards image and image_field to /zehntage/add", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toEndWith("/zehntage/add");
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await addCard({
      front: "猫",
      back: "cat",
      context: "Hyouka @ 1:23",
      image: "/tmp/anki-mcp-uploads/abc.png",
      image_field: "context",
    });
    expect(body!.image).toBe("/tmp/anki-mcp-uploads/abc.png");
    expect(body!.image_field).toBe("context");
    expect(body!.context).toBe("Hyouka @ 1:23");
  });
});
