import assert from "node:assert/strict";
import test from "node:test";
import { startChannelAfterRecovery } from "../src/channel-startup.ts";
import type { ChannelMessage } from "../src/channel.ts";

const message = (id: string) => ({ messageId: id }) as ChannelMessage;

test("startup buffers connected messages until recovery and then retains arrival order", async () => {
  const events: string[] = [];
  let incoming!: (message: ChannelMessage) => void;
  await startChannelAfterRecovery({ start: async handler => {
    incoming = handler;
    handler(message("first"));
    await Promise.resolve();
    handler(message("second"));
    assert.deepEqual(events, []);
  }, stop: async () => { events.push("stop"); } }, () => { events.push("recover"); }, m => { events.push(m.messageId); });
  incoming(message("third"));
  assert.deepEqual(events, ["recover", "first", "second", "third"]);
});

test("failed startup recovery closes the channel and never dispatches buffered or late messages", async () => {
  const events: string[] = [];
  let incoming!: (message: ChannelMessage) => void;
  await assert.rejects(startChannelAfterRecovery({ start: async handler => {
    incoming = handler; handler(message("first"));
  }, stop: async () => { events.push("stop"); } }, () => { throw new Error("recovery failed"); }, m => { events.push(m.messageId); }), /recovery failed/);
  incoming(message("late"));
  assert.deepEqual(events, ["stop"]);
});

test("startup overflow fails explicitly instead of partially running queued messages", async () => {
  const events: string[] = [];
  await assert.rejects(startChannelAfterRecovery({ start: async handler => {
    handler(message("first")); handler(message("second"));
  }, stop: async () => { events.push("stop"); } }, () => { events.push("recover"); }, m => { events.push(m.messageId); }, 1), /积压超限/);
  assert.deepEqual(events, ["stop"]);
});
