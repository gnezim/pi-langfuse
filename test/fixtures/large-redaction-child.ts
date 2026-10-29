import assert from "node:assert/strict";
import { redactString } from "../../src/redaction.ts";

for (const input of ["PASSWORD".repeat(125_000), "PASSWORD-".repeat(125_000)]) {
  assert.equal(redactString(input, { maxStringLength: 12_000 }), input.slice(0, 12_000) + "... [truncated]");
}
assert.equal(redactString('TOKEN="' + "synthetic ".repeat(100_000) + '"'), "TOKEN=[REDACTED_SECRET]");
