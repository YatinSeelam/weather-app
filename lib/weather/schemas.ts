import { z } from "zod";
import { DEFAULT_EMAIL_MODE, MAX_MONITOR_EMAILS, MAX_RADIUS_MILES, MIN_RADIUS_MILES } from "./constants";
import { RISK_SELECTIONS, type RiskSelection } from "./types";

export const zipCodeSchema = z
  .string("Enter a 5-digit U.S. ZIP code.")
  .trim()
  .regex(/^\d{5}$/, "Enter a 5-digit U.S. ZIP code.");

export const radiusMilesSchema = z
  .number("Radius must be a number of miles.")
  .min(MIN_RADIUS_MILES, `Radius must be at least ${MIN_RADIUS_MILES} miles.`)
  .max(MAX_RADIUS_MILES, `Radius can be at most ${MAX_RADIUS_MILES} miles.`);

export const risksSchema = z
  .array(z.enum(RISK_SELECTIONS, "Unknown weather risk."))
  .min(1, "Choose at least one weather risk.")
  .transform((risks): RiskSelection[] => [...new Set(risks)]);

export const intervalMinutesSchema = z.union(
  [z.literal(15), z.literal(60), z.literal(180)],
  "Check frequency must be 15, 60 or 180 minutes.",
);

export const emailsSchema = z
  .array(z.string("Enter a valid email address.").trim().toLowerCase().pipe(z.email("Enter a valid email address.")))
  .max(MAX_MONITOR_EMAILS, `A monitor can email at most ${MAX_MONITOR_EMAILS} addresses.`)
  .transform((emails) => [...new Set(emails)]);

export const emailModeSchema = z.enum(["every-check", "changes-only"], "Choose when to send email.");

export const checkRequestSchema = z.object({
  zipCode: zipCodeSchema,
  radiusMiles: radiusMilesSchema,
  risks: risksSchema.default([...RISK_SELECTIONS]),
});
export type CheckRequest = z.infer<typeof checkRequestSchema>;

const monitorNameSchema = z.string().trim().min(1, "Name cannot be empty.").max(60, "Name can be at most 60 characters.");

export const createMonitorSchema = checkRequestSchema.extend({
  intervalMinutes: intervalMinutesSchema,
  name: monitorNameSchema.optional(),
  emails: emailsSchema.default([]),
  emailMode: emailModeSchema.default(DEFAULT_EMAIL_MODE),
});
export type CreateMonitorRequest = z.infer<typeof createMonitorSchema>;

export const updateMonitorSchema = z
  .object({
    name: monitorNameSchema,
    enabled: z.boolean(),
    radiusMiles: radiusMilesSchema,
    intervalMinutes: intervalMinutesSchema,
    risks: risksSchema,
    emails: emailsSchema,
    emailMode: emailModeSchema,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Provide at least one field to update.");
export type UpdateMonitorRequest = z.infer<typeof updateMonitorSchema>;

export type FieldIssue = { field: string; message: string };

export function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
}
