// The validator `tools/call` runs on a tool's arguments. The parameters it
// checks are the tool contract's (`ToolShape` in `@lanework/protocol`), the
// same ones `tools/list` advertises as JSON Schema, so the two cannot
// disagree.
//
// NOTE: Unknown arguments are dropped, not refused, as the cloud's zod schemas
// do. An agent that sends a field this build does not know (say
// `assignees.users`) must still get its card.
import type { ToolParam, ToolShape } from "@lanework/protocol";

/** A tool call whose arguments do not match the tool's {@link ToolShape}. */
export class InvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParams";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkParam(path: string, param: ToolParam, value: unknown): unknown {
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
  shape: ToolShape,
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
