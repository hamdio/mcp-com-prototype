import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentMessage,
  classifyComError,
  ComError,
  RPC_E_CALL_REJECTED,
  RPC_E_DISCONNECTED,
  RPC_S_SERVER_UNAVAILABLE,
  ToolError,
} from "../src/errors.ts";

test("busy HRESULT is transient", () => {
  assert.equal(classifyComError(RPC_E_CALL_REJECTED), "transient");
});

test("server-gone HRESULTs mean the session is lost", () => {
  assert.equal(classifyComError(RPC_S_SERVER_UNAVAILABLE), "session_lost");
  assert.equal(classifyComError(RPC_E_DISCONNECTED), "session_lost");
});

test("unknown HRESULT is permanent", () => {
  assert.equal(classifyComError(0x80004005), "permanent"); // E_FAIL
});

test("signed HRESULT from a COM bridge classifies the same as unsigned", () => {
  assert.equal(classifyComError(RPC_E_CALL_REJECTED | 0), "transient"); // -2147418111
  assert.equal(new ComError(RPC_E_CALL_REJECTED | 0, "x").hresult, RPC_E_CALL_REJECTED);
});

test("agent message hides internal detail except for invalid_input", () => {
  assert.equal(agentMessage(new ToolError("app_error", "0x80004005 at C:\\secret")), "The desktop application reported an error.");
  assert.equal(agentMessage(new ToolError("invalid_input", '"itemId" must be a non-empty string.')), '"itemId" must be a non-empty string.');
});
