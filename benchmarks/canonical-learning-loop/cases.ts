export type CanonicalLearningProofCase = {
  id: string;
  clusterKey: string;
  split: "train" | "validation" | "frozen_eval";
  cohort: "adaptation" | "development" | "held_out" | "control";
  artifactKind: "html" | "markdown" | "json";
  outputPath: string;
  mediaType: string;
  prompt: string;
  requiredSections: string[];
  prohibitedClaims: string[];
};

const html = (
  id: string,
  split: CanonicalLearningProofCase["split"],
  cohort: CanonicalLearningProofCase["cohort"],
  subject: string,
  requiredSections: string[],
  prohibitedClaims: string[] = [],
): CanonicalLearningProofCase => ({
  id,
  clusterKey: `cluster-${id}`,
  split,
  cohort,
  artifactKind: "html",
  outputPath: "index.html",
  mediaType: "text/html",
  prompt: `Create a complete standalone HTML page for ${subject}. Save the finished artifact as index.html and return it only after validating the file. Use embedded CSS and no external assets.`,
  requiredSections,
  prohibitedClaims,
});

export const CANONICAL_LEARNING_PROOF_CASES: CanonicalLearningProofCase[] = [
  html("train-bakery", "train", "adaptation", "Juniper & Rye bakery", ["Juniper & Rye", "Featured items", "Hours", "Contact"]),
  html("train-status", "train", "adaptation", "Northstar Cloud status", ["System status", "Components", "Uptime", "Incidents"]),
  html("train-conference", "train", "adaptation", "Local Design Conference registration", ["Tickets", "Attendee information", "Accessibility", "Confirmation"]),
  html("train-knowledge-base", "train", "adaptation", "a troubleshooting knowledge base", ["Search", "Installation", "Warnings", "Commands"]),
  html("train-nonprofit", "train", "adaptation", "Harbor Youth annual report", ["Mission", "Programs", "Impact", "Financials"]),
  html("train-restaurant", "train", "adaptation", "Siam Garden restaurant menu", ["Starters", "Mains", "Dietary labels", "Prices"]),
  html("train-pricing", "train", "adaptation", "three project-management plans", ["Starter", "Team", "Business", "Frequently asked questions"]),
  html("train-portfolio", "train", "adaptation", "a product designer case study", ["Problem", "Research", "Decisions", "Outcomes"]),

  html("dev-community-center", "validation", "development", "Riverside Community Center", ["Programs", "Schedule", "Accessibility", "Location"]),
  html("dev-cafe", "validation", "development", "Maple Street Cafe", ["Breakfast", "Lunch", "Hours", "Contact"]),
  html("dev-incident", "validation", "development", "Atlas API incident review", ["Timeline", "Impact", "Recovery", "Follow-up"]),
  html("dev-workshop", "validation", "development", "a ceramics workshop registration", ["Sessions", "Registration", "Materials", "Accessibility"]),

  html("held-clinic", "frozen_eval", "held_out", "Lakeside Clinic relocation", ["New address", "Opening date", "Services", "Contact"], ["emergency room"]),
  html("held-museum", "frozen_eval", "held_out", "a local history museum exhibit", ["Overview", "Highlights", "Visiting hours", "Accessibility"]),
  html("held-library", "frozen_eval", "held_out", "Cedar Library programs", ["Children", "Adults", "Calendar", "Registration"]),
  html("held-transit", "frozen_eval", "held_out", "Metro service changes", ["Routes", "Dates", "Alternatives", "Accessibility"], ["no delays guaranteed"]),
  html("held-volunteer", "frozen_eval", "held_out", "food pantry volunteer onboarding", ["Roles", "Schedule", "Safety", "Contact"]),
  html("held-product-docs", "frozen_eval", "held_out", "an analytics product guide", ["Overview", "Setup", "Permissions", "Troubleshooting"]),

  {
    id: "control-release-notes",
    clusterKey: "cluster-control-release-notes",
    split: "frozen_eval",
    cohort: "control",
    artifactKind: "markdown",
    outputPath: "release-notes.md",
    mediaType: "text/markdown",
    prompt: "Write concise release notes with Summary, Changes, Upgrade notes, and Support sections. Save them as release-notes.md.",
    requiredSections: ["Summary", "Changes", "Upgrade notes", "Support"],
    prohibitedClaims: [],
  },
  {
    id: "control-service-manifest",
    clusterKey: "cluster-control-service-manifest",
    split: "frozen_eval",
    cohort: "control",
    artifactKind: "json",
    outputPath: "service-manifest.json",
    mediaType: "application/json",
    prompt: "Create service-manifest.json with name, owner, environment, and healthCheck fields.",
    requiredSections: ["name", "owner", "environment", "healthCheck"],
    prohibitedClaims: [],
  },
];
