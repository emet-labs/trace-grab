import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RawRecord } from "../src/normalize/index.js";
import { readOtlpJson } from "../src/sources/index.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "otlp-export.json");

const records: RawRecord[] = readOtlpJson(FIXTURE_PATH);

const byId = (id: string): RawRecord => {
  const r = records.find((rec) => rec.id === id);
  if (!r) throw new Error(`record ${id} not found`);
  return r;
};

describe("otlp parser", () => {
  test("parses one record per span across both resources", () => {
    expect(records).toHaveLength(5);
    expect(records.every((r) => r.source.vendor === "otlp")).toBe(true);
  });

  test("AnyValue variants round-trip with correct JS types", () => {
    const http = byId("ee1479f1beab96a4");
    expect(http.attributes["http.method"]).toBe("GET"); // string
    expect(http.attributes["http.status_code"]).toBe(200); // int
    expect(http.attributes["http.duration_ms"]).toBe(42.5); // double
    expect(http.attributes["cache.hit"]).toBe(true); // bool
    // array of ints
    const retry = byId("ee1479f1beab96a5").attributes["retry.counts"];
    expect(retry).toEqual([1, 2, 3]);
    // kvlist -> object
    const headers = http.attributes["response.headers"] as Record<string, unknown>;
    expect(headers).toEqual({ "content-type": "application/json", "x-trace-id": "abc123" });
    // bytes -> base64 string kept verbatim
    expect(http.attributes["payload.bytes"]).toBe("aGVsbG8gd29ybGQ=");
  });

  test("nanosecond timestamps convert to ISO-8601 UTC", () => {
    const http = byId("ee1479f1beab96a4");
    // 1700000000_000000000 ns -> 1700000000000 ms -> 2023-11-14T22:13:20.000Z
    expect(http.start).toBe("2023-11-14T22:13:20.000Z");
    // 1700000000500000000 -> +5s
    expect(http.end).toBe("2023-11-14T22:13:25.000Z");
  });

  test("end is null when endTimeUnixNano is absent (in-flight)", () => {
    const consume = byId("ff00aabbccdd0001");
    expect(consume.end).toBeNull();
  });

  test("links produce links[] with trace_id and span_id", () => {
    const http = byId("ee1479f1beab96a4");
    expect(http.links).toHaveLength(1);
    expect(http.links[0].trace_id).toBe("ff7651916cd43dd8348d211272f4bff");
    expect(http.links[0].span_id).toBe("aa1479f1beab96b0");
    expect(http.links[0].attributes["link.reason"]).toBe("fan-in");
    // spans without links get an empty array
    expect(byId("ee1479f1beab96a5").links).toEqual([]);
  });

  test("resource attributes appear as attributes.resource.*", () => {
    const http = byId("ee1479f1beab96a4");
    const resource = http.attributes.resource as Record<string, unknown>;
    expect(resource["service.name"]).toBe("checkout-service");
    expect(resource["service.version"]).toBe("1.4.2");
    const consume = byId("ff00aabbccdd0001");
    const inv = consume.attributes.resource as Record<string, unknown>;
    expect(inv["service.name"]).toBe("inventory-service");
  });

  test("scope attributes appear as attributes.scope.*", () => {
    const http = byId("ee1479f1beab96a4");
    const scope = http.attributes.scope as Record<string, unknown>;
    expect(scope.name).toBe("io.opentelemetry.tomcat");
    expect(scope.language).toBe("java");
  });

  test("OTLP span kind int maps to name string", () => {
    expect(byId("ee1479f1beab96a4").kind).toBe("server"); // 1
    expect(byId("ee1479f1beab96a5").kind).toBe("client"); // 2
    expect(byId("ee1479f1beab96a6").kind).toBe("internal"); // 0
    expect(byId("ff00aabbccdd0001").kind).toBe("consumer"); // 4
    expect(byId("ff00aabbccdd0002").kind).toBe("producer"); // 3
  });

  test("status maps onto unset/ok/error and error.message", () => {
    expect(byId("ee1479f1beab96a4").status).toBe("ok"); // code 1
    expect(byId("ee1479f1beab96a5").status).toBe("error"); // code 2
    expect(byId("ee1479f1beab96a5").error).toEqual({
      kind: "error",
      message: "card declined",
    });
    expect(byId("ee1479f1beab96a6").status).toBe("unset"); // code 0
    expect(byId("ee1479f1beab96a6").error).toBeNull();
  });

  test("dangling parent is preserved verbatim", () => {
    const consume = byId("ff00aabbccdd0001");
    // parentSpanId references a span absent from the corpus — must NOT be coerced to null
    expect(consume.parent_id).toBe("deadbeef00000000");
    const ids = new Set(records.map((r) => r.id));
    expect(ids.has("deadbeef00000000")).toBe(false);
  });

  test("root span has null parent_id", () => {
    expect(byId("ee1479f1beab96a4").parent_id).toBeNull();
  });

  test("gen_ai.* attributes stay in attributes (do-not-interpret default)", () => {
    const chat = byId("ee1479f1beab96a6");
    expect(chat.attributes["gen_ai.request.model"]).toBe("gpt-4");
    expect(chat.attributes["gen_ai.response.model"]).toBe("gpt-4-0613");
    expect(chat.attributes["gen_ai.usage.prompt_tokens"]).toBe(128);
    expect(chat.attributes["gen_ai.usage.completion_tokens"]).toBe(64);
    // not promoted to inputs/outputs
    expect(chat.inputs).toEqual({});
    expect(chat.outputs).toEqual({});
  });

  test("labels is always empty", () => {
    expect(records.every((r) => r.labels.length === 0)).toBe(true);
  });

  test("unrecognized span fields land in unmapped", () => {
    const http = byId("ee1479f1beab96a4");
    expect(http.unmapped["flags"]).toBe(256);
    // recognized fields are not duplicated into unmapped
    expect("traceId" in http.unmapped).toBe(false);
    expect("spanId" in http.unmapped).toBe(false);
  });
});
