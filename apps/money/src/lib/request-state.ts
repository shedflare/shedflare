export type RequestResult<Value> = { ok: true; value: Value } | { ok: false; error: string };

export async function loadRequest<Value>(
  read: () => Promise<Value>,
): Promise<RequestResult<Value>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load data" };
  }
}

export function requestValue<Value>(result: RequestResult<Value> | undefined): Value | undefined {
  return result?.ok ? result.value : undefined;
}

export function requestError<Value>(result: RequestResult<Value> | undefined): string | null {
  return result && !result.ok ? result.error : null;
}
