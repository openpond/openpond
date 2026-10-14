import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SqliteStore } from "../store/store.js";

const Invocation = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1), expiresAt: z.number().int() }).strict();

/** Process-owned association capability. It grants no API authentication;
 * the CLI still uses the installation's existing authenticated transport. */
export function createChatCliInvocation(store: Pick<SqliteStore, "getSession" | "getTurn">) {
  const secret = randomBytes(32);
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest();
  async function validate(sessionId: string, turnId: string) {
    const [session, turn] = await Promise.all([store.getSession(sessionId), store.getTurn(turnId)]);
    if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "") || !turn || turn.sessionId !== sessionId || turn.status !== "in_progress") {
      throw new Error("CLI invocation belongs to an unavailable conversation turn.");
    }
    return { sessionId, turnId };
  }
  async function issue(sessionId: string, turnId: string) {
    await validate(sessionId, turnId);
    const body = Buffer.from(JSON.stringify({ sessionId, turnId, expiresAt: Date.now() + 3_600_000 })).toString("base64url");
    return `${body}.${sign(body).toString("base64url")}`;
  }
  async function resolve(token: string) {
    if (token.length > 2000) throw new Error("Invalid CLI invocation context.");
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw new Error("Invalid CLI invocation context.");
    const actual = Buffer.from(signature, "base64url"), expected = sign(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid CLI invocation context.");
    const value = Invocation.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (value.expiresAt < Date.now()) throw new Error("CLI invocation context expired.");
    return validate(value.sessionId, value.turnId);
  }
  return { issue, resolve };
}
