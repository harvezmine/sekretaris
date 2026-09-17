import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { createCodes } from "../onboarding/codes.js";
import type { Payments } from "../payments/service.js";
import { safeEqual } from "../wa/verify.js";
import { listUsers, usageReport } from "./reports.js";

const codeBody = z.object({
  kind: z.enum(["trial", "pendiri"]),
  count: z.coerce.number().int().min(1).max(500).default(1),
  maxUses: z.coerce.number().int().min(1).max(10_000).default(1),
  trialDays: z.coerce.number().int().min(1).max(90).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(365).default(30),
  source: z.string().max(80).optional(),
  prefix: z.string().regex(/^[A-Za-z0-9]{2,12}$/).optional(),
});

export async function adminRoutes(app: FastifyInstance, opts: { payments: Payments }): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeEqual(token, config.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post("/codes", async (req, reply) => {
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const codes = await createCodes(parsed.data);
    return { codes: codes.map((c) => ({ code: c.code, kind: c.kind, maxUses: c.maxUses, expiresAt: c.expiresAt })) };
  });

  app.get("/usage", async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days ?? 7), 1), 365);
    return usageReport(days);
  });

  app.get("/users", async () => ({ users: await listUsers() }));

  app.post("/payments/:ref/paid", async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const changed = await opts.payments.markPaid(ref);
    return changed ? { ok: true } : reply.code(404).send({ ok: false, error: "tidak ada pembayaran tertunda dengan referensi itu" });
  });
}
