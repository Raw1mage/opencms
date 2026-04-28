import z from "zod"
import { Tool } from "./tool"
import { ToolBudget } from "./budget"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { abortAfterAny } from "../util/abort"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
    timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
  }),
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }

    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      always: ["*"],
      metadata: {
        url: params.url,
        format: params.format,
        timeout: params.timeout,
      },
    })

    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    const { signal, clearTimeout } = abortAfterAny(timeout, ctx.abort)

    // Build Accept header based on requested format with q parameters for fallbacks
    let acceptHeader = "*/*"
    switch (params.format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        break
      default:
        acceptHeader =
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    }

    const initial = await fetch(params.url, { signal, headers })

    // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
    const response =
      initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
        ? await fetch(params.url, { signal, headers: { ...headers, "User-Agent": "opencode" } })
        : initial

    clearTimeout()

    if (!response.ok) {
      throw new Error(`Request failed with status code: ${response.status}`)
    }

    // Check content length
    const contentLength = response.headers.get("content-length")
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)")
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)")
    }

    const contentType = response.headers.get("content-type") || ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""

    const title = `${params.url} (${contentType})`

    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"

    if (isImage) {
      const base64Content = Buffer.from(arrayBuffer).toString("base64")
      return {
        title,
        output: "Image fetched successfully",
        metadata: {},
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${base64Content}`,
          },
        ],
      }
    }

    const content = new TextDecoder().decode(arrayBuffer)

    // Compute the format-specific body once, then apply Layer 2 bound.
    let body: string
    switch (params.format) {
      case "markdown":
        body = contentType.includes("text/html") ? convertHTMLToMarkdown(content) : content
        break
      case "text":
        body = contentType.includes("text/html") ? await extractTextFromHTML(content) : content
        break
      case "html":
      default:
        body = content
        break
    }

    // Layer 2 (specs/tool-output-chunking/, DD-2): token-aware bound.
    // The 5MB hard cap above is a memory/network safeguard; the per-tool
    // token budget is what the model actually has room for. INV-8: when
    // body fits the budget, returned output is byte-identical to
    // pre-Layer-2 behaviour.
    const budget = ToolBudget.resolve(ctx, "webfetch")
    const bodyTokens = ToolBudget.estimateTokens(body)
    let outputBody = body
    let truncated = false
    if (bodyTokens > budget.tokens) {
      // Slice from the head; web pages typically front-load important
      // content (titles, intro). Shrink in 15% steps until the bounded
      // output (with its hint) fits.
      const targetChars = Math.max(0, budget.tokens * 4)
      let kept = Math.min(body.length, targetChars)
      while (kept > 0) {
        const head = body.slice(0, kept)
        const hint =
          `\n\n---\n[webfetch output bounded at ~${budget.tokens} tokens by Layer 2 ` +
          `(${budget.source}); ${bodyTokens - ToolBudget.estimateTokens(head)} tokens omitted from tail. ` +
          `If you need more, fetch the URL again with a Range header (e.g. via bash + curl), ` +
          `or scrape only the section you need with grep/web tools.]`
        const candidate = head + hint
        if (ToolBudget.estimateTokens(candidate) <= budget.tokens) {
          outputBody = candidate
          truncated = true
          break
        }
        kept = Math.max(0, Math.floor(kept * 0.85))
      }
    }

    return {
      output: outputBody,
      title,
      metadata: truncated ? { truncated: true } : {},
    }
  },
})

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
