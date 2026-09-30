/**
 * The normalized Odoo history at the service interface: what `prepare()` hands to the router and
 * to the adapter (see test/integration/e2e-providers.test.ts for what reaches each provider).
 */
import { describe, expect, it } from "vitest";

import { agentPayload, createTestGateway } from "../helpers/gateway.js";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";

describe("normalized history", () => {
  it("is what the adapter receives: canonical mimetypes, no empty attachments, no Odoo metadata", async () => {
    const gw = createTestGateway();
    gw.adapters.openai.then([{ type: "text", text: "Seen." }]);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "inline_data", mimetype: "image/png", data: "", metadata: { image_path: "/web/image/x" } },
          { type: "inline_data", mimetype: "IMAGE/JPG", data: PNG, metadata: { attachment_id: 5 } },
          {
            type: "tool_result",
            tool_name: "read_file",
            tool_call_id: "c1",
            success: true,
            result: [{ type: "inline_data", mimetype: "application/json; charset=utf-8", data: "e30=" }],
          },
        ],
      },
    ];
    const res = await gw.rpc("1/get_completions_sync", agentPayload({ messages }));
    expect(res.body.result.result.content).toEqual([{ type: "text", text: "Seen." }]);
    expect(gw.adapters.openai.completions[0]!.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "inline_data", mimetype: "image/png", data: PNG },
          {
            type: "tool_result",
            tool_name: "read_file",
            tool_call_id: "c1",
            success: true,
            result: [{ type: "inline_data", mimetype: "application/json", data: "e30=" }],
          },
        ],
      },
    ]);
  });

  it("routes on the canonical type: a PDF with parameters still needs pdf_input", async () => {
    const gw = createTestGateway(undefined, { unsupported: { openai: ["pdf_input"] } });
    const messages = [{ role: "user", content: [{ type: "inline_data", mimetype: "Application/PDF; name=invoice.pdf", data: "JVBERi0=" }] }];
    const res = await gw.rpc("1/get_completions_sync", agentPayload({ messages }));
    expect(res.body.error.data.name).toBe("odoo_ai_gateway.errors.UnsupportedFeatureError");
    expect(res.body.error.data.message).toContain("pdf_input");
    expect(gw.adapters.openai.completions).toHaveLength(0);
  });

  it("needs no input feature for empty attachments, text files or SVG", async () => {
    const gw = createTestGateway(undefined, { unsupported: { openai: ["image_input", "pdf_input", "audio_input"] } });
    gw.adapters.openai.then([{ type: "text", text: "ok" }]);
    const svg = Buffer.from("<svg><circle r='4'/></svg>").toString("base64");
    const messages = [
      {
        role: "user",
        content: [
          { type: "inline_data", mimetype: "image/png", data: "" },
          { type: "inline_data", mimetype: "text/csv", data: "YSxi" },
          { type: "inline_data", mimetype: "image/svg+xml", data: svg },
        ],
      },
    ];
    const res = await gw.rpc("1/get_completions_sync", agentPayload({ messages }));
    expect(res.body.result.result.content).toEqual([{ type: "text", text: "ok" }]);
  });
});
