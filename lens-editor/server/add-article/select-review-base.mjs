#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { selectReviewBase } from "./select-review-base-core.mjs";

const server = new McpServer({
  name: "article-review-base-selector",
  version: "1.0.0",
});

server.registerTool(
  "select_review_base",
  {
    title: "Select article review base",
    description: "Copies one extraction candidate to article.md and reveals both candidates' validator findings. May be called once.",
    inputSchema: z.object({
      base: z.enum(["rendered", "unrendered"]),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ base }) => {
    await selectReviewBase({
      workDir: process.cwd(),
      base,
      renderedValidationSource: process.env.ARTICLE_REVIEW_RENDERED_VALIDATION_PATH,
      unrenderedValidationSource: process.env.ARTICLE_REVIEW_UNRENDERED_VALIDATION_PATH,
    });
    return {
      content: [{
        type: "text",
        text: `Selected ${base} as article.md. Validator findings are now available.`,
      }],
    };
  },
);

await server.connect(new StdioServerTransport());
