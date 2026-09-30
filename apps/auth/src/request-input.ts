export async function readAuthInput(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > 4096) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  const contentType = request.headers.get("content-type")?.split(";")[0];
  try {
    if (contentType === "application/json") {
      const input: unknown = JSON.parse(text);
      return input;
    }
    if (contentType === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams(text);
      return { ...Object.fromEntries(form), days: Number(form.get("days")) };
    }
  } catch {
    return null;
  }
  return null;
}
