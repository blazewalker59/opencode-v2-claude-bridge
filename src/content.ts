import type { ChatContentPart, ChatMessage } from "./openai.js"

/** Image types Claude accepts as image input. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
type ImageType = (typeof IMAGE_TYPES)[number]

/** A content block in an Agent SDK user message (the Messages API shapes the bridge produces). */
export type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageType; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string }

/** What a prompt carries: plain text, or text plus attachment blocks. */
export type PromptContent = string | ClaudeBlock[]

/** An MCP tool-result content block (the subset the bridge produces). */
export type McpBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

type Attachment = { label: string; block: Extract<ClaudeBlock, { type: "image" | "document" }> }

/** Media types some clients use for a type Claude knows by another name. */
const MEDIA_TYPE_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Standard, padded base64: URL-safe characters are mapped back and missing padding is added. */
const normalizeBase64 = (data: string): string => {
  const standard = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  return standard.length % 4 === 0 ? standard : standard.padEnd(standard.length + 4 - (standard.length % 4), "=")
}

type DataUrl = { mediaType: string; data: string } | { invalid: string }

/**
 * A base64 data URL, with any parameters (such as `charset`) before
 * `;base64`. The data is checked here: Claude rejects a whole request over
 * one malformed attachment, and a session that replays it would fail on every
 * later turn.
 */
const parseDataUrl = (url: string): DataUrl | undefined => {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.*)$/is.exec(url)
  if (!match) return undefined
  const type = match[1]!.trim().toLowerCase()
  const mediaType = MEDIA_TYPE_ALIASES[type] ?? type
  const data = normalizeBase64(match[2]!)
  // Three padding characters means one stray character: no encoder produces that.
  if (data.length === 0 || data.endsWith("===") || !BASE64.test(data)) return { invalid: mediaType }
  return { mediaType, data }
}

const isImageType = (mediaType: string): mediaType is ImageType => (IMAGE_TYPES as readonly string[]).includes(mediaType)

/**
 * Turn one OpenCode content part into an attachment, or explain why it
 * cannot be passed to Claude. OpenCode sends images as `image_url` parts and
 * PDFs as `file` parts with a data URL.
 */
const toAttachment = (part: ChatContentPart): Attachment | { unsupported: string } => {
  if (part.type === "image_url") {
    const url = part.image_url?.url ?? ""
    const data = parseDataUrl(url)
    if (data && "invalid" in data) return { unsupported: `${data.invalid} image with malformed base64 data` }
    if (data) {
      return isImageType(data.mediaType)
        ? { label: data.mediaType, block: { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } } }
        : { unsupported: `image type ${data.mediaType}` }
    }
    if (/^https?:\/\//i.test(url)) return { label: "image (URL)", block: { type: "image", source: { type: "url", url } } }
    return { unsupported: "image without a data or http(s) URL" }
  }
  if (part.type === "file") {
    const name = part.file?.filename
    const data = parseDataUrl(part.file?.file_data ?? "")
    if (data && "invalid" in data) return { unsupported: `${name ? `file ${name}` : "file"} (${data.invalid}) with malformed base64 data` }
    if (data?.mediaType === "application/pdf") {
      return {
        label: `application/pdf${name ? ` ${name}` : ""}`,
        block: { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.data }, ...(name ? { title: name } : {}) },
      }
    }
    const kind = data?.mediaType ?? "no data"
    return { unsupported: name ? `file ${name} (${kind})` : `file (${kind})` }
  }
  return { unsupported: `content part ${String(part.type)}` }
}

/**
 * Collects attachments while rendering a transcript, so the text can refer to
 * each one by number and the blocks follow the text in the same message.
 */
export class PromptAttachments {
  private readonly attachments: Attachment[] = []

  /** Render content as text, replacing each attachment with a numbered marker. Nothing is dropped silently. */
  render(content: ChatMessage["content"]): string {
    if (typeof content === "string") return content
    if (!content) return ""
    return content
      .map((part) => {
        if (part.type === undefined || part.type === "text") return part.text ?? ""
        const attachment = toAttachment(part)
        if ("unsupported" in attachment) return `[unsupported attachment omitted: ${attachment.unsupported}]`
        this.attachments.push(attachment)
        return `[attachment ${this.attachments.length}: ${attachment.label}]`
      })
      .join("")
  }

  /** The prompt: the text alone, or the text followed by each attachment, labelled. */
  prompt(text: string): PromptContent {
    if (this.attachments.length === 0) return text
    return [
      { type: "text", text },
      ...this.attachments.flatMap((attachment, index): ClaudeBlock[] => [
        { type: "text", text: `Attachment ${index + 1}:` },
        attachment.block,
      ]),
    ]
  }
}

/**
 * Content for an MCP tool result. Images become MCP image blocks; anything
 * else that is not text (a PDF, for example) becomes an explicit note, since
 * tool results carry text and images only.
 */
export const toMcpBlocks = (content: ChatMessage["content"]): McpBlock[] => {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : []
  if (!content) return []
  return content.flatMap((part): McpBlock[] => {
    if (part.type === undefined || part.type === "text") return part.text ? [{ type: "text", text: part.text }] : []
    const attachment = toAttachment(part)
    if ("unsupported" in attachment) return [{ type: "text", text: `[unsupported attachment omitted: ${attachment.unsupported}]` }]
    const source = attachment.block.source
    if (attachment.block.type === "image" && source.type === "base64") {
      return [{ type: "image", data: source.data, mimeType: source.media_type }]
    }
    return [{ type: "text", text: `[attachment not passed through a tool result: ${attachment.label}]` }]
  })
}

/**
 * A stable key for message content, covering attachments as well as text.
 * Only the fields the bridge reads are included, so a field OpenCode adds to
 * a part (cache hints, image detail) never makes a matching history look
 * edited.
 */
export const contentKey = (content: ChatMessage["content"]): unknown => {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : []
  if (!content) return []
  return content
    .filter((part) => !((part.type === undefined || part.type === "text") && !part.text))
    .map((part) => {
      if (part.type === undefined || part.type === "text") return { type: "text", text: part.text }
      if (part.type === "image_url") return { type: part.type, url: part.image_url?.url ?? null }
      if (part.type === "file") return { type: part.type, filename: part.file?.filename ?? null, data: part.file?.file_data ?? null }
      return { type: part.type }
    })
}
