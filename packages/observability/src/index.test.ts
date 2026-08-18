import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { withCorrelation } from "./index.js";

describe("observability", () => {
  it("redacts credentials and preserves correlation identifiers", () => {
    let output = "";
    const destination = new Writable({
      write: (chunk, _encoding, done) => {
        output += chunk.toString();
        done();
      },
    });
    const logger = pino(
      {
        redact: {
          paths: ["authorization", "providerCredential"],
          censor: "[REDACTED]",
        },
      },
      destination,
    );

    withCorrelation(logger, { requestId: "request-1", taskId: "task-1" }).info({
      authorization: "Bearer secret",
      providerCredential: "provider-secret",
    });

    expect(output).toContain("request-1");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("provider-secret");
  });
});
