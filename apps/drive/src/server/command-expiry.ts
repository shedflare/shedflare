import {
  integer,
  looseObject,
  maxValue,
  minValue,
  number,
  optional,
  pipe,
  safeParse,
} from "valibot";

const CommandOptions = looseObject({
  expiresInSeconds: optional(pipe(number(), integer(), minValue(30), maxValue(900)), 120),
});

export function commandExpiry<Body>(body: Body): number | null {
  const parsed = safeParse(CommandOptions, body);
  return parsed.success ? Date.now() + parsed.output.expiresInSeconds * 1_000 : null;
}
