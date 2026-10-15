import assert from "node:assert/strict"
import test from "node:test"
import { contentKey, PromptAttachments } from "../src/content.js"
import { toAgentPrompt } from "../src/openai.js"
import { fingerprint, planTurn } from "../src/sessions.js"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const image = (data = PNG, type = "image/png") => ({ type: "image_url", image_url: { url: `data:${type};base64,${data}` } })
const pdf = { type: "file", file: { filename: "tiny.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjEK" } }

test("text-only prompts stay plain strings", () => {
  assert.equal(typeof toAgentPrompt([{ role: "user", content: "hello" }]), "string")
})

test("images and PDFs become numbered markers followed by Claude blocks", () => {
  const prompt = toAgentPrompt([
    { role: "user", content: [{ type: "text", text: "Compare " }, image(), { type: "text", text: " with " }, pdf] },
  ])
  assert.ok(Array.isArray(prompt))
  assert.match(prompt[0]?.type === "text" ? prompt[0].text : "", /Compare \[attachment 1: image\/png\] with \[attachment 2: application\/pdf tiny\.pdf\]/)
  assert.deepEqual(prompt.slice(1), [
    { type: "text", text: "Attachment 1:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    { type: "text", text: "Attachment 2:" },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjEK" }, title: "tiny.pdf" },
  ])
})

test("remote images pass by URL; unsupported parts are named, never dropped silently", () => {
  const attachments = new PromptAttachments()
  const text = attachments.render([
    { type: "image_url", image_url: { url: "https://example.test/a.png" } },
    image("AAAA", "image/bmp"),
    { type: "input_audio" },
    { type: "file", file: { filename: "notes.docx", file_data: "data:application/msword;base64,AAAA" } },
  ])
  assert.equal(
    text,
    "[attachment 1: image (URL)][unsupported attachment omitted: image type image/bmp][unsupported attachment omitted: content part input_audio][unsupported attachment omitted: file notes.docx (application/msword)]",
  )
  assert.deepEqual(attachments.prompt("t"), [
    { type: "text", text: "t" },
    { type: "text", text: "Attachment 1:" },
    { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
  ])
})

test("a resumed turn sends the new message's attachments", () => {
  const history = [{ role: "user" as const, content: "hi" }]
  const plans = planTurn(
    [...history, { role: "assistant", content: "hello" }, { role: "user", content: [{ type: "text", text: "What is this? " }, image()] }],
    { sdkSessionId: "sdk-1", history: history.map(fingerprint) },
    true,
  )
  assert.equal(plans[0]?.reason, "resume")
  assert.deepEqual(plans[0]?.prompt, [
    { type: "text", text: "What is this? [attachment 1: image/png]" },
    { type: "text", text: "Attachment 1:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ])
})

test("fingerprints cover attachments, so a different image is a different message", () => {
  const withImage = (data: string) => fingerprint({ role: "user", content: [{ type: "text", text: "look" }, image(data)] })
  assert.notEqual(withImage(PNG), withImage("AAAA"))
  assert.equal(fingerprint({ role: "user", content: "a" }), fingerprint({ role: "user", content: [{ type: "text", text: "a" }] }))
  assert.deepEqual(contentKey(""), [])
})

test("image/jpg and data-URL parameters are accepted", () => {
  const attachments = new PromptAttachments()
  attachments.render([image(PNG, "image/jpg"), { type: "image_url", image_url: { url: `data:image/png;charset=binary;base64,${PNG}` } }])
  const blocks = attachments.prompt("x")
  assert.ok(Array.isArray(blocks))
  assert.deepEqual(
    blocks.flatMap((block) => (block.type === "image" && block.source.type === "base64" ? [block.source.media_type] : [])),
    ["image/jpeg", "image/png"],
  )
})

test("malformed base64 is named and left out, so a replayed session never carries it", () => {
  const attachments = new PromptAttachments()
  const text = attachments.render([
    image("not base64!"),
    image("AAAAA"),
    { type: "file", file: { filename: "bad.pdf", file_data: "data:application/pdf;base64,%%%%" } },
  ])
  assert.equal(
    text,
    "[unsupported attachment omitted: image/png image with malformed base64 data][unsupported attachment omitted: image/png image with malformed base64 data][unsupported attachment omitted: file bad.pdf (application/pdf) with malformed base64 data]",
  )
  assert.equal(attachments.prompt(text), text, "no attachment blocks")
})

test("unpadded and URL-safe base64 is normalized, not rejected", () => {
  const attachments = new PromptAttachments()
  attachments.render([image("AAA"), image("-_8"), image("AA\nAA")])
  const blocks = attachments.prompt("x")
  assert.ok(Array.isArray(blocks))
  assert.deepEqual(
    blocks.flatMap((block) => (block.type === "image" && block.source.type === "base64" ? [block.source.data] : [])),
    ["AAA=", "+/8=", "AAAA"],
  )
})
