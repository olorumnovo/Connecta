// Keep stored messages intact; only replace embedded bytes in browser responses.
export function conversationMedia(body: string): { mediaKind: string; mimeType: string; fileName: string; caption: string; dataUrl: string } | null {
  if (!body.startsWith("{")) return null;
  try {
    const value = JSON.parse(body);
    if (value.kind !== "media" || typeof value.dataUrl !== "string" || !/^data:[^;,]+;base64,/.test(value.dataUrl)) return null;
    return {
      mediaKind: typeof value.mediaKind === "string" ? value.mediaKind : "document",
      mimeType: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream",
      fileName: typeof value.fileName === "string" ? value.fileName : "arquivo",
      caption: typeof value.caption === "string" ? value.caption : "",
      dataUrl: value.dataUrl,
    };
  } catch { return null; }
}

export function lightweightMessageBody(id: string, body: string, preview = false) {
  const media = conversationMedia(body);
  if (!media) return preview ? body.slice(0, 500) : body;
  return JSON.stringify({
    kind: "media", ...media,
    caption: preview ? media.caption.slice(0, 500) : media.caption,
    dataUrl: `/api/conversations/media/${encodeURIComponent(id)}`,
  });
}
