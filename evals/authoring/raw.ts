import type {
  ArtifactRequirement,
  ReportRequirement,
  VerifierSpec,
  WorkflowCheck,
} from '../lib/types.js';

export function rawWorkflowCheck(check: WorkflowCheck): WorkflowCheck {
  return check;
}

export function rawVerifier(verifier: VerifierSpec): VerifierSpec {
  return verifier;
}

export function rawArtifactRequirement(
  requirement: ArtifactRequirement,
): ArtifactRequirement {
  return requirement;
}

export function rawReportRequirement(
  requirement: ReportRequirement,
): ReportRequirement {
  return requirement;
}
