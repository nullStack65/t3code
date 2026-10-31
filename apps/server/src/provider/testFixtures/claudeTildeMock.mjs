#!/usr/bin/env node
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("claude 2.1.219\n");
  process.exit(0);
}

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          models: [],
          output_style: "default",
          available_output_styles: ["default"],
          account: { email: "test@example.com", subscriptionType: "pro", tokenSource: "oauth" },
        },
      },
    }) + "\n",
  );
});
setInterval(() => {}, 1_000);
