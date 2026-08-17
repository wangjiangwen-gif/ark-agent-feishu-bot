import assert from "node:assert/strict";
import test from "node:test";
import { EMPLOYEE_CALENDAR_USER_SCOPES, needsCalendarAuthorization } from "../src/employee-auth.ts";

test("calendar scheduling requests require user authorization", () => {
  assert.equal(needsCalendarAuthorization("帮我安排明天下午的日程"), true);
  assert.equal(needsCalendarAuthorization("帮我创建一份飞书文档"), false);
  assert.ok(EMPLOYEE_CALENDAR_USER_SCOPES.includes("calendar:calendar.free_busy:read"));
});
