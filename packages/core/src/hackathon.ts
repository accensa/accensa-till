/**
 * Validates a hackathon submission payload against HACKATHON.md contract (task H6).
 *
 * Hard constraints from HACKATHON.md:
 * - requestId: UUID
 * - projectName: 2-80 chars
 * - leadName: 2-80 chars
 * - email: valid email, max 160 chars
 * - size: one of "1", "2 - 4", "4 - 6", "6 - 8", "8+"
 * - tracks: subset of the 13 official tracks, non-empty, unique
 * - nearAddress: 2-64 chars, lowercase NEAR address regex
 * - projectUrl: valid HTTP/HTTPS URL, max 300 chars
 * - demoUrl: valid HTTP/HTTPS URL, max 300 chars
 * - idea: 20-2000 chars
 * - consent: exactly true
 * - website: spam trap, must be undefined or absent
 * - body size <= 12000 bytes
 */

export const HACKATHON_TRACKS = [
  "defi",
  "thesis",
  "privacy",
  "business",
  "swarms",
  "security",
  "agents",
  "realworld",
  "games",
  "nfts",
  "memecoins",
  "social",
  "open",
] as const;

export type HackathonTrack = (typeof HACKATHON_TRACKS)[number];

export const VALID_TEAM_SIZES = ["1", "2 - 4", "4 - 6", "6 - 8", "8+"] as const;
export type TeamSize = (typeof VALID_TEAM_SIZES)[number];

export const nearAccountRegex = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SubmissionPayload = {
  readonly requestId: string;
  readonly projectName: string;
  readonly leadName: string;
  readonly email: string;
  readonly size: TeamSize;
  readonly tracks: readonly HackathonTrack[];
  readonly nearAddress: string;
  readonly projectUrl: string;
  readonly demoUrl: string;
  readonly idea: string;
  readonly consent: boolean;
  readonly website?: string;
};

export function validateSubmissionPayload(input: unknown): {
  readonly valid: boolean;
  readonly payload?: SubmissionPayload;
  readonly errors?: readonly string[];
  readonly byteLength?: number;
} {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return { valid: false, errors: ["Payload must be a non-null object"] };
  }

  const raw = input as Record<string, unknown>;

  // Check for website spam trap
  if ("website" in raw && raw.website !== undefined && raw.website !== "") {
    errors.push("website is a spam trap: any non-empty value rejects the submission");
  }

  // requestId
  if (typeof raw.requestId !== "string" || !uuidRegex.test(raw.requestId)) {
    errors.push("requestId must be a valid UUID string");
  }

  // projectName
  if (
    typeof raw.projectName !== "string" ||
    raw.projectName.length < 2 ||
    raw.projectName.length > 80
  ) {
    errors.push("projectName must be 2-80 characters");
  }

  // leadName
  if (typeof raw.leadName !== "string" || raw.leadName.length < 2 || raw.leadName.length > 80) {
    errors.push("leadName must be 2-80 characters");
  }

  // email
  if (typeof raw.email !== "string" || raw.email.length > 160 || !emailRegex.test(raw.email)) {
    errors.push("email must be a valid email address (max 160 chars)");
  }

  // size
  if (typeof raw.size !== "string" || !VALID_TEAM_SIZES.includes(raw.size as TeamSize)) {
    errors.push(`size must be one of: ${VALID_TEAM_SIZES.join(", ")}`);
  }

  // tracks
  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    errors.push("tracks must be a non-empty array of valid track ids");
  } else {
    const invalidTracks = raw.tracks.filter(
      (t) => typeof t !== "string" || !HACKATHON_TRACKS.includes(t as HackathonTrack),
    );
    if (invalidTracks.length > 0) {
      errors.push(`tracks contains invalid track ids: ${invalidTracks.join(", ")}`);
    }
    const trackSet = new Set(raw.tracks);
    if (trackSet.size !== raw.tracks.length) {
      errors.push("tracks must not contain duplicates");
    }
  }

  // nearAddress
  if (
    typeof raw.nearAddress !== "string" ||
    raw.nearAddress.length < 2 ||
    raw.nearAddress.length > 64 ||
    !nearAccountRegex.test(raw.nearAddress) ||
    raw.nearAddress !== raw.nearAddress.toLowerCase()
  ) {
    errors.push(
      "nearAddress must be 2-64 characters, lowercase, matching ^(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+$",
    );
  }

  // projectUrl
  if (
    typeof raw.projectUrl !== "string" ||
    raw.projectUrl.length > 300 ||
    (!raw.projectUrl.startsWith("http://") && !raw.projectUrl.startsWith("https://"))
  ) {
    errors.push("projectUrl must be a public http/https URL (max 300 chars)");
  }

  // demoUrl
  if (
    typeof raw.demoUrl !== "string" ||
    raw.demoUrl.length > 300 ||
    (!raw.demoUrl.startsWith("http://") && !raw.demoUrl.startsWith("https://"))
  ) {
    errors.push("demoUrl must be a public http/https URL to the demo post on X (max 300 chars)");
  }

  // idea
  if (typeof raw.idea !== "string" || raw.idea.length < 20 || raw.idea.length > 2000) {
    errors.push(
      "idea must be 20 to 2,000 characters describing the problem, product, and NEAR role",
    );
  }

  // consent
  if (raw.consent !== true) {
    errors.push(
      'consent must be true, confirmed after reading: "I agree that the organizers may use these details to review our submission and contact us about this hackathon."',
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const payload = raw as unknown as SubmissionPayload;
  const jsonString = JSON.stringify(payload);
  const byteLength = new TextEncoder().encode(jsonString).length;

  if (byteLength > 12000) {
    return {
      valid: false,
      errors: [`Total payload size is ${byteLength} bytes, exceeds maximum 12,000 bytes`],
      byteLength,
    };
  }

  return {
    valid: true,
    payload,
    byteLength,
  };
}
