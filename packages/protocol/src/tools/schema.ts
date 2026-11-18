// A tool's parameters, spelled once (FE-152). The JSON Schema an MCP server
// advertises in `tools/list` derives from it, and so does the validator the
// desktop's servers run on `tools/call`, so the two cannot disagree. It is
// small on purpose: the tools need strings, booleans, integers, enums, string
// lists, string maps and lists of flat objects.

/** One tool parameter: its type and the limits a validator enforces. */
export type ToolParam =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "boolean"; description?: string }
  | {
      type: "integer";
      description?: string;
      minimum?: number;
      maximum?: number;
    }
  | { type: "string[]"; description?: string }
  | { type: "nullable-string"; description?: string }
  | { type: "string-map"; description?: string }
  | {
      type: "object";
      description?: string;
      properties: Readonly<Record<string, ToolParam>>;
      required?: readonly string[];
    }
  | {
      type: "object[]";
      description?: string;
      properties: Readonly<Record<string, ToolParam>>;
      required?: readonly string[];
      minItems?: number;
    };

/** A tool's parameters: each one by name, and which are required. */
export interface ToolShape {
  properties: Readonly<Record<string, ToolParam>>;
  required?: readonly string[];
}

/** One tool as every server and client of it states it. */
export interface ToolContract<Name extends string = string> extends ToolShape {
  name: Name;
  /** Sent to the model verbatim. A literal: it sits in a cached prompt prefix. */
  description: string;
  /** True when the tool changes nothing (MCP's `readOnlyHint`). */
  readOnly: boolean;
}

/** A JSON Schema object, as `tools/list` carries it. */
export type JsonSchema = Record<string, unknown>;

function paramSchema(param: ToolParam): JsonSchema {
  const described = (schema: JsonSchema): JsonSchema =>
    param.description ? { ...schema, description: param.description } : schema;
  switch (param.type) {
    case "string":
      return described(
        param.enum
          ? { type: "string", enum: [...param.enum] }
          : { type: "string" },
      );
    case "boolean":
      return described({ type: "boolean" });
    case "integer":
      return described({
        type: "integer",
        ...(param.minimum !== undefined ? { minimum: param.minimum } : {}),
        ...(param.maximum !== undefined ? { maximum: param.maximum } : {}),
      });
    case "string[]":
      return described({ type: "array", items: { type: "string" } });
    case "nullable-string":
      return described({ type: ["string", "null"] });
    case "string-map":
      return described({
        type: "object",
        additionalProperties: { type: ["string", "null"] },
      });
    case "object":
      return described(toolInputSchema(param));
    case "object[]":
      return described({
        type: "array",
        items: toolInputSchema(param),
        ...(param.minItems ? { minItems: param.minItems } : {}),
      });
  }
}

/**
 * The JSON Schema `tools/list` advertises for a {@link ToolShape}.
 *
 * NOTE: `additionalProperties: false` is what the schema says; servers still
 * drop unknown arguments rather than refuse them, as the cloud's zod schemas
 * do.
 */
export function toolInputSchema(shape: ToolShape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, param] of Object.entries(shape.properties))
    properties[name] = paramSchema(param);
  return {
    type: "object",
    properties,
    ...(shape.required?.length ? { required: [...shape.required] } : {}),
    additionalProperties: false,
  };
}
