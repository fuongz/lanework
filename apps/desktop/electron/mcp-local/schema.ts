// A tool's parameters, spelled once. The JSON Schema that `tools/list`
// advertises and the validator that `tools/call` runs both derive from it, so
// the two cannot disagree. It is small on purpose: the board tools need
// strings, booleans, integers, enums, string lists, string maps and lists of
// flat objects.
//
// NOTE: Unknown arguments are dropped, not refused, as the cloud's zod schemas
// do. An agent that sends a field this build does not know (say
// `assignees.users`) must still get its card.

/** One tool parameter: its type and the limits the validator enforces. */
export type Param =
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
      properties: Record<string, Param>;
      required?: readonly string[];
    }
  | {
      type: "object[]";
      description?: string;
      properties: Record<string, Param>;
      required?: readonly string[];
      minItems?: number;
    };

/** A tool's parameters: each one by name, and which are required. */
export interface Shape {
  properties: Record<string, Param>;
  required?: readonly string[];
}

type JsonSchema = Record<string, unknown>;

function paramSchema(param: Param): JsonSchema {
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
      return described(shapeSchema(param));
    case "object[]":
      return described({
        type: "array",
        items: shapeSchema(param),
        ...(param.minItems ? { minItems: param.minItems } : {}),
      });
  }
}

/** Build the JSON Schema that `tools/list` advertises for a {@link Shape}. */
export function shapeSchema(shape: Shape): JsonSchema {
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

/** A tool call whose arguments do not match the tool's {@link Shape}. */
export class InvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParams";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkParam(path: string, param: Param, value: unknown): unknown {
  const fail = (expected: string): never => {
    throw new InvalidParams(`${path} must be ${expected}`);
  };
  switch (param.type) {
    case "string":
      if (typeof value !== "string") fail("a string");
      if (param.enum && !param.enum.includes(value as string))
        fail(`one of ${param.enum.join(", ")}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail("true or false");
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value))
        fail("an integer");
      if (param.minimum !== undefined && (value as number) < param.minimum)
        fail(`at least ${param.minimum}`);
      if (param.maximum !== undefined && (value as number) > param.maximum)
        fail(`at most ${param.maximum}`);
      return value;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        fail("a list of strings");
      return value;
    case "nullable-string":
      if (value !== null && typeof value !== "string") fail("a string or null");
      return value;
    case "string-map":
      if (
        !isObject(value) ||
        Object.values(value).some((v) => v !== null && typeof v !== "string")
      )
        fail("an object of strings (or null)");
      return value;
    case "object":
      if (!isObject(value)) fail("an object");
      return checkShape(param, value, `${path}.`);
    case "object[]": {
      if (!Array.isArray(value)) fail("a list");
      const list = value as unknown[];
      if (param.minItems && list.length < param.minItems)
        fail(`a list of at least ${param.minItems}`);
      return list.map((entry, index) => {
        if (!isObject(entry)) fail(`a list of objects (item ${index})`);
        return checkShape(param, entry, `${path}[${index}].`);
      });
    }
  }
}

/**
 * Check `args` against `shape`, dropping unknown keys and absent optionals.
 *
 * @param prefix The path of the enclosing object, for error messages.
 * @returns The arguments the shape knows, validated.
 * @throws {@link InvalidParams} when an argument is missing or has the wrong
 *   type.
 */
export function checkShape(
  shape: Shape,
  args: unknown,
  prefix = "",
): Record<string, unknown> {
  const input = args === undefined || args === null ? {} : args;
  if (!isObject(input)) throw new InvalidParams("arguments must be an object");
  const out: Record<string, unknown> = {};
  for (const name of shape.required ?? [])
    if (input[name] === undefined || input[name] === null)
      throw new InvalidParams(`${prefix}${name} is required`);
  for (const [name, param] of Object.entries(shape.properties)) {
    const value = input[name];
    if (value === undefined) continue;
    // A null optional is "not given", except where null is a value of its own.
    if (value === null && param.type !== "nullable-string") continue;
    out[name] = checkParam(`${prefix}${name}`, param, value);
  }
  return out;
}
