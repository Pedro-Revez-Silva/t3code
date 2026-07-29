const CODEX_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCodexNativeTurnId(nativeTurnId: string): boolean {
  return CODEX_UUID_V7_PATTERN.test(nativeTurnId);
}

export function isCodexNativeTurnAfterBarrier(
  nativeTurnId: string,
  nativeTurnIdBarrier: string,
): boolean {
  // Codex exposes submission IDs as turn IDs and relies on UUIDv7 lexical creation order.
  return (
    isCodexNativeTurnId(nativeTurnId) &&
    isCodexNativeTurnId(nativeTurnIdBarrier) &&
    nativeTurnId.toLowerCase() > nativeTurnIdBarrier.toLowerCase()
  );
}
