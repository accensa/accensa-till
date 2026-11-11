import {
  HACKATHON_TRACKS,
  type SubmissionPayload,
  VALID_TEAM_SIZES,
  validateSubmissionPayload,
} from "../packages/core/src/hackathon.ts";

export { HACKATHON_TRACKS, type SubmissionPayload, VALID_TEAM_SIZES, validateSubmissionPayload };

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("HACKATHON.md Submission Validator loaded.");
  console.log(`Allowed tracks: ${HACKATHON_TRACKS.join(", ")}`);
  console.log(`Allowed team sizes: ${VALID_TEAM_SIZES.join(", ")}`);
}
