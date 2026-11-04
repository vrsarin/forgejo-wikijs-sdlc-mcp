/** Reads a Web stream without allowing an upstream or caller to exhaust process memory. */
export async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  if (!stream) throw new Error('Body is required')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      // A cloned/teed request may keep the other branch open, so cancellation must not block rejection.
      void reader.cancel()
      throw new Error('Message exceeds size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
