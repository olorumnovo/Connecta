import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCurrentUser } from "@/lib/auth-context";
import { authErrorResponse } from "@/lib/api-errors";
import { conversationMedia } from "@/lib/conversation-media";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ messageId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { messageId } = await context.params;
    if (!z.string().uuid().safeParse(messageId).success) return new NextResponse(null, { status: 404 });
    const message = await prisma.chatMessage.findFirst({
      where: { id: messageId, conversation: { deletedAt: null, ...(user.role === "ADMIN" ? {} : { ownerUserId: user.id }) } },
      select: { body: true },
    });
    const media = message && conversationMedia(message.body);
    if (!media) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    const etag = `"${createHash("sha256").update(media.dataUrl).digest("hex")}"`;
    const headers = new Headers({
      "Cache-Control": "private, no-cache", "Vary": "Cookie", "ETag": etag,
      "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
    const separator = media.dataUrl.indexOf(",");
    const mime = media.dataUrl.slice(5, separator).split(";")[0].toLowerCase();
    const inline = /^(image\/(jpeg|png|gif|webp)|audio\/(mpeg|mp3|ogg|mp4|aac|amr|wav|webm)|video\/(mp4|webm))$/.test(mime);
    headers.set("Content-Type", inline ? mime : "application/octet-stream");
    const filename = encodeURIComponent(media.fileName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    headers.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`);
    const bytes = Buffer.from(media.dataUrl.slice(separator + 1), "base64");
    let start = 0, end = bytes.length - 1, status = 200;
    const range = request.headers.get("range");
    if (range && (!request.headers.get("if-range") || request.headers.get("if-range") === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      } else start = bytes.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
        headers.set("Content-Range", `bytes */${bytes.length}`);
        return new NextResponse(null, { status: 416, headers });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    }
    headers.set("Content-Length", String(end - start + 1));
    let offset = start;
    // Stream large existing attachments instead of buffering a function response.
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset > end) { controller.close(); return; }
      const next = Math.min(offset + 65536, end + 1);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, next)));
      offset = next;
    } });
    return new NextResponse(stream, { status, headers });
  } catch (error) {
    return authErrorResponse(error) ?? new NextResponse(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
