import {
  type DiscrepancyDto,
  type EndpointDto,
  type HealthDto,
  type PaymentDto,
  discrepancyDtoSchema,
  endpointDtoSchema,
  healthDtoSchema,
  paymentDtoSchema,
} from "@till/core";
import type { z } from "zod";

/**
 * Typed fetch for the dashboard (PROJECT_STRUCTURE.md: web never imports from
 * api). Every response is parsed with the shared schema before it is used, so a
 * drift in the API is a thrown parse error here rather than `undefined` two
 * components later.
 *
 * Paths go to /api/*, which next.config.ts rewrites onto the API process, so the
 * session cookie stays first-party.
 */
async function get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) {
    throw new Error("session missing or expired — sign in again (UI-1)");
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return schema.parse(await response.json());
}

export const api = {
  health: (): Promise<HealthDto> => get("/api/health", healthDtoSchema),
  endpoints: (): Promise<readonly EndpointDto[]> =>
    get("/api/endpoints", endpointDtoSchema.array()),
  payments: (): Promise<readonly PaymentDto[]> => get("/api/payments", paymentDtoSchema.array()),
  discrepancies: (): Promise<readonly DiscrepancyDto[]> =>
    get("/api/discrepancies", discrepancyDtoSchema.array()),
};
