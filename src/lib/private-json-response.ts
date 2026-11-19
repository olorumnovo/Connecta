import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

// Authentication and permission checks must run before calling this helper.
export function privateJsonResponse(request: Request, payload: { timestamp?: string; [key: string]: unknown }) {
  const { timestamp: _timestamp, ...stable } = payload;
  const etag = `W/"${createHash("sha256").update(JSON.stringify(stable)).digest("hex")}"`;
  const headers = { "Cache-Control": "private, no-cache", "Vary": "Cookie", "ETag": etag };
  if (request.headers.get("if-none-match")?.split(",").map(value => value.trim()).includes(etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(payload, { headers });
}
