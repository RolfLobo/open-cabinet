/**
 * Access switch for /askai and POST /api/ask.
 *
 * Ask the data is public (Sept. 17, 2026). One environment variable,
 * ASKAI_CLOSED=1, turns the box off everywhere without a code deploy: the
 * page shows a closed notice and the API refuses before it spends
 * anything. The rate limits and the durable daily spending cap in
 * lib/ask/limits.ts and the route are what bound cost while it is open.
 *
 * The shared-password alpha gate that lived here from Sept. 7 to Sept. 17
 * is gone; there are no accounts and nothing is stored per person.
 */

export function askaiClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ASKAI_CLOSED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function askaiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !askaiClosed(env);
}

/** Route handlers: may this request use the box? Public unless closed. */
export function requestHasAskaiAccess(_request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  return askaiEnabled(env);
}
