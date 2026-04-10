export interface TranscribeOptions {
  sessionID: string
  audio: Blob
  mime: string
}

export interface TranscribeResult {
  text: string
}

/**
 * Upload an audio blob to the server for transcription.
 * Returns the transcribed text or throws on failure.
 */
export async function transcribeAudio(
  serverUrl: string,
  authorizedFetch: typeof fetch,
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const form = new FormData()
  const ext = options.mime.includes("mp4") ? "mp4" : options.mime.includes("ogg") ? "ogg" : "webm"
  form.append("audio", new File([options.audio], `recording.${ext}`, { type: options.mime }))

  const res = await authorizedFetch(
    `${serverUrl}/api/v2/session/${encodeURIComponent(options.sessionID)}/transcribe`,
    {
      method: "POST",
      body: form,
    },
  )

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: "Transcription request failed" }))
    throw new Error(body.message || `Transcription failed (${res.status})`)
  }

  return res.json()
}
