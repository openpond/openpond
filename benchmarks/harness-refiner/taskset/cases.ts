export type BenchmarkCase = {
  id: string;
  clusterKey: string;
  split: "validation" | "frozen_eval";
  prompt: string;
  attachmentPaths?: string[];
  expectedOutput: {
    deliverable: "pdf" | "spreadsheet" | "report" | "message" | "agenda";
    mustInclude: string[];
    mustNot: string[];
    validation: Array<"structural" | "visual" | "test" | "user_review">;
  };
  tags: string[];
};

export const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    id: "adaptation-board-launch-brief",
    clusterKey: "northstar-launch-packet",
    split: "validation",
    prompt:
      "Please turn the attached Northstar launch packet into a polished two-page PDF decision brief for the executive meeting. Make the three options, owners, dates, confirmed facts, open gates, and risks easy to scan. The source records no final choice, so do not select, recommend, or imply a preferred option. Visually check the finished PDF before you send it back.",
    attachmentPaths: ["fixtures/adaptation-board-launch.md"],
    expectedOutput: {
      deliverable: "pdf",
      mustInclude: ["three decision options", "owners and dates", "confirmed facts", "open legal and finance gates"],
      mustNot: ["present an open gate as approved", "invent a recommended decision"],
      validation: ["structural", "visual"],
    },
    tags: ["artifact-verification", "decision-brief", "adaptation"],
  },
  {
    id: "adaptation-latency-incident-review",
    clusterKey: "checkout-latency-incident-packet",
    split: "validation",
    prompt:
      "Create a concise PDF incident review from the attached checkout latency packet. Clearly separate confirmed observations, recovery actions, hypotheses, unknowns, customer impact, and follow-up owners. Check that the rendered PDF is readable and complete.",
    attachmentPaths: ["fixtures/adaptation-latency-incident.md"],
    expectedOutput: {
      deliverable: "pdf",
      mustInclude: ["incident window", "confirmed impact", "recovery", "hypotheses labeled as hypotheses", "unknowns", "follow-up owners"],
      mustNot: ["state either hypothesis as root cause", "claim unresolved carts were recovered"],
      validation: ["structural", "visual"],
    },
    tags: ["artifact-verification", "incident-review", "adaptation"],
  },
  {
    id: "adaptation-program-budget-workbook",
    clusterKey: "harbor-program-budget-packet",
    split: "validation",
    prompt:
      "Build an Excel workbook from the attached Harbor youth program budget. Include a one-page summary and a detail sheet with formulas for full-year forecast and variance, clearly flag forecast overruns, preserve the listed owners, and verify the calculations before returning it.",
    attachmentPaths: ["fixtures/adaptation-program-budget.md"],
    expectedOutput: {
      deliverable: "spreadsheet",
      mustInclude: ["summary sheet", "detail sheet", "formula-driven full-year forecast", "formula-driven variance", "owner column", "overrun flag"],
      mustNot: ["replace formulas with typed totals", "reverse the variance sign"],
      validation: ["structural", "test"],
    },
    tags: ["artifact-verification", "spreadsheet", "adaptation"],
  },
  {
    id: "adaptation-customer-launch-handoff",
    clusterKey: "atlas-launch-handoff-packet",
    split: "validation",
    prompt:
      "Turn the attached Atlas customer launch notes into a one-page PDF handoff. Preserve the local timezone, owners, confirmed work, pending gates, open question, go/no-go meeting, and rollback authority. Visually inspect the final page before returning it.",
    attachmentPaths: ["fixtures/adaptation-launch-handoff.md"],
    expectedOutput: {
      deliverable: "pdf",
      mustInclude: ["Europe/London timezone", "confirmed work", "pending allowlist and rehearsal", "coverage question", "rollback owner", "go/no-go meeting"],
      mustNot: ["mark pending work complete", "answer the coverage question"],
      validation: ["structural", "visual"],
    },
    tags: ["artifact-verification", "handoff", "adaptation"],
  },
  {
    id: "adaptation-nextjs-security-audit",
    clusterKey: "nextjs-security-current-sources",
    split: "validation",
    prompt:
      "Audit the currently supported Next.js release lines for security advisories published in the last twelve months. Use primary sources, explain which versions are affected and fixed, avoid inferring that a project is vulnerable without its exact version and configuration, and give me a concise linked report with the date checked.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["official advisory links", "affected and fixed versions", "date checked", "limits on exposure inference"],
      mustNot: ["declare exposure without project version and configuration", "use an uncited vulnerability list"],
      validation: [],
    },
    tags: ["research-efficiency", "primary-sources", "security", "adaptation"],
  },
  {
    id: "adaptation-rag-paper-comparison",
    clusterKey: "rag-research-paper-sources",
    split: "validation",
    prompt:
      "Compare three influential retrieval-augmented generation papers from the last five years. Link the papers, summarize each experimental setup and evaluation data, and explain what can and cannot be compared across them instead of forcing their headline numbers into one leaderboard.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["three direct paper links", "experimental setup", "evaluation data", "cross-paper comparability limits"],
      mustNot: ["rank incomparable headline metrics", "attribute a result to the wrong paper"],
      validation: [],
    },
    tags: ["research-efficiency", "primary-sources", "papers", "adaptation"],
  },
  {
    id: "adaptation-accessible-boston-dc-plan",
    clusterKey: "boston-dc-accessibility-sources",
    split: "validation",
    prompt:
      "Plan a wheelchair-accessible train trip from Boston to Washington, DC for September 17, 2026, returning September 19. Verify accessibility and disruption information from official sources, distinguish facts from anything that still needs confirmation, include direct links and the time checked, and keep the answer practical and concise.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["official operator sources", "outbound and return plan", "accessibility details", "disruption check", "time checked", "items needing confirmation"],
      mustNot: ["guarantee availability not confirmed by booking", "hide access limitations"],
      validation: [],
    },
    tags: ["research-efficiency", "current-information", "travel", "adaptation"],
  },
  {
    id: "adaptation-chatgpt-public-experiences",
    clusterKey: "chatgpt-x-reddit-public-sample",
    split: "validation",
    prompt:
      "Research what people have publicly said about using ChatGPT on X and Reddit during the last thirty days. Give me a concise, linked summary of recurring positive and negative experiences, separate patterns from anecdotes, include dates, and explain any platform-access or sampling limitations. Do not post or interact with anyone.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["links to public examples", "dates", "positive experiences", "negative experiences", "pattern versus anecdote", "sampling limitations"],
      mustNot: ["post or interact", "represent a convenience sample as representative sentiment"],
      validation: [],
    },
    tags: ["research-efficiency", "current-information", "social-research", "adaptation"],
  },
  {
    id: "adaptation-launch-delay-email",
    clusterKey: "acme-launch-delay-message",
    split: "validation",
    prompt:
      "Draft a calm email to the Acme pilot customers explaining that the August 20 launch is moving to August 27 because final accessibility testing is not complete. Testing is expected to finish August 22, existing pilot access remains available, and questions should go to pilot-support@example.com. Keep it under 140 words and do not imply the test has failed.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["August 27", "accessibility testing incomplete", "August 22 expectation", "pilot access remains", "support email"],
      mustNot: ["say testing failed", "exceed 140 words", "invent compensation"],
      validation: [],
    },
    tags: ["constraint-following", "communication", "adaptation"],
  },
  {
    id: "adaptation-quarterly-review-agenda",
    clusterKey: "solstice-quarterly-review-agenda",
    split: "validation",
    prompt:
      "Create a 30-minute agenda for the Solstice quarterly review. Cover a five-minute metrics review led by Amina, ten minutes on customer retention led by Luis, ten minutes on the Q4 experiment decision led by Grace, and a five-minute recap with owners. Note that the pricing analysis is still pending and must not be treated as a completed input.",
    expectedOutput: {
      deliverable: "agenda",
      mustInclude: ["30 total minutes", "all four timed sections", "Amina", "Luis", "Grace", "pricing analysis pending"],
      mustNot: ["treat pricing analysis as complete", "exceed 30 minutes"],
      validation: [],
    },
    tags: ["constraint-following", "agenda", "adaptation"],
  },
  {
    id: "frozen-clinic-relocation-brief",
    clusterKey: "riverside-clinic-relocation-packet",
    split: "frozen_eval",
    prompt:
      "Please turn the attached Riverside clinic relocation packet into a polished two-page PDF decision brief. Make the opening options, owners, dates, confirmed facts, unresolved approvals, and delivery risk easy to scan, and visually check the finished PDF before returning it.",
    attachmentPaths: ["fixtures/frozen-clinic-relocation.md"],
    expectedOutput: {
      deliverable: "pdf",
      mustInclude: ["three opening options", "owners and dates", "confirmed facts", "permit and parking gates", "delivery risk"],
      mustNot: ["present either approval as complete", "invent a chosen opening option"],
      validation: ["structural", "visual"],
    },
    tags: ["artifact-verification", "decision-brief", "frozen-eval"],
  },
  {
    id: "frozen-payment-incident-review",
    clusterKey: "subscription-renewal-incident-packet",
    split: "frozen_eval",
    prompt:
      "Create a concise PDF incident review from the attached subscription renewal incident packet. Separate confirmed impact and recovery from the root-cause hypothesis and unresolved customer accounts, preserve the owners, and check the rendered PDF for readability and completeness.",
    attachmentPaths: ["fixtures/frozen-payment-incident.md"],
    expectedOutput: {
      deliverable: "pdf",
      mustInclude: ["incident window", "attempt and timeout counts", "recovery", "hypothesis label", "33 unresolved accounts", "follow-up owners"],
      mustNot: ["state the certificate hypothesis as confirmed", "claim all accounts resolved"],
      validation: ["structural", "visual"],
    },
    tags: ["artifact-verification", "incident-review", "frozen-eval"],
  },
  {
    id: "frozen-grant-budget-workbook",
    clusterKey: "greenway-grant-budget-packet",
    split: "frozen_eval",
    prompt:
      "Build an Excel workbook from the attached Greenway community grant budget. Include a one-page summary and detail sheet with formulas for full-year forecast and variance, flag forecast overruns, preserve owners, and verify all calculations before returning it.",
    attachmentPaths: ["fixtures/frozen-grant-budget.md"],
    expectedOutput: {
      deliverable: "spreadsheet",
      mustInclude: ["summary sheet", "detail sheet", "formula-driven full-year forecast", "formula-driven variance", "owner column", "overrun flag"],
      mustNot: ["replace formulas with typed totals", "reverse the variance sign"],
      validation: ["structural", "test"],
    },
    tags: ["artifact-verification", "spreadsheet", "frozen-eval"],
  },
  {
    id: "frozen-warehouse-handoff",
    clusterKey: "beacon-warehouse-handoff-packet",
    split: "frozen_eval",
    prompt:
      "Turn the attached Beacon warehouse migration notes into a one-page PDF handoff. Preserve the local timezone, owners, confirmed work, pending carrier and rehearsal gates, open security question, go/no-go meeting, and failback authority. Visually inspect the final page before returning it.",
    attachmentPaths: ["fixtures/frozen-warehouse-handoff.md"],
    expectedOutput: {
      deliverable: "pdf",
      mustInclude: ["America/Los_Angeles timezone", "confirmed work", "pending carrier and rehearsal items", "security question", "failback owner", "go/no-go meeting"],
      mustNot: ["mark pending work complete", "answer the security question"],
      validation: ["structural", "visual"],
    },
    tags: ["artifact-verification", "handoff", "frozen-eval"],
  },
  {
    id: "frozen-python-requests-security-audit",
    clusterKey: "python-requests-security-current-sources",
    split: "frozen_eval",
    prompt:
      "Audit the supported Python Requests release lines for security advisories published in the last eighteen months. Use primary sources, identify affected and fixed versions, avoid claiming a specific deployment is exposed without its exact dependency graph and usage, and provide a concise linked report with the date checked.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["primary advisory links", "affected and fixed versions", "date checked", "dependency and usage caveat"],
      mustNot: ["declare deployment exposure without evidence", "use an uncited vulnerability list"],
      validation: [],
    },
    tags: ["research-efficiency", "primary-sources", "security", "frozen-eval"],
  },
  {
    id: "frozen-speech-paper-comparison",
    clusterKey: "speech-model-research-paper-sources",
    split: "frozen_eval",
    prompt:
      "Compare three influential open speech-recognition papers from the last five years. Link the papers, summarize the training and evaluation setup, and explain which reported quality and efficiency results are genuinely comparable instead of turning different datasets into a single ranking.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["three direct paper links", "training setup", "evaluation setup", "quality and efficiency results", "comparability limits"],
      mustNot: ["rank metrics from incompatible datasets", "attribute a result to the wrong paper"],
      validation: [],
    },
    tags: ["research-efficiency", "primary-sources", "papers", "frozen-eval"],
  },
  {
    id: "frozen-accessible-chicago-stl-plan",
    clusterKey: "chicago-stl-accessibility-sources",
    split: "frozen_eval",
    prompt:
      "Plan a wheelchair-accessible train trip from Chicago to St. Louis for October 8, 2026, returning October 10. Verify accessibility and disruption information from official sources, distinguish confirmed facts from anything requiring booking confirmation, include direct links and the time checked, and keep it practical.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["official operator sources", "outbound and return plan", "accessibility details", "disruption check", "time checked", "items needing confirmation"],
      mustNot: ["guarantee unconfirmed availability", "hide access limitations"],
      validation: [],
    },
    tags: ["research-efficiency", "current-information", "travel", "frozen-eval"],
  },
  {
    id: "frozen-new-jersey-youth-grants",
    clusterKey: "new-jersey-youth-grant-sources",
    split: "frozen_eval",
    prompt:
      "Find currently open grants that a New Jersey nonprofit running after-school programs could realistically apply for, with deadlines between now and December 31, 2026. Use authoritative sources, link each opportunity, verify eligibility and deadline, omit weak matches instead of padding the list, and state when you checked.",
    expectedOutput: {
      deliverable: "report",
      mustInclude: ["authoritative source links", "eligibility evidence", "deadlines", "date checked", "only realistic matches"],
      mustNot: ["include closed grants", "include grants without verified nonprofit and program eligibility", "pad the list"],
      validation: [],
    },
    tags: ["research-efficiency", "current-information", "funding", "frozen-eval"],
  },
  {
    id: "frozen-maintenance-followup-email",
    clusterKey: "maple-maintenance-followup-message",
    split: "frozen_eval",
    prompt:
      "Draft a firm but courteous email to Maple Property Management following up on a bedroom window that has not closed securely since July 28. Maintenance inspected it August 1 but did not repair it. Ask for a repair date within two business days, mention the security concern, and keep the email under 130 words without making legal threats.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["July 28", "August 1 inspection", "security concern", "repair date within two business days"],
      mustNot: ["make a legal threat", "claim facts not supplied", "exceed 130 words"],
      validation: [],
    },
    tags: ["constraint-following", "communication", "frozen-eval"],
  },
  {
    id: "frozen-operations-review-agenda",
    clusterKey: "meridian-operations-review-agenda",
    split: "frozen_eval",
    prompt:
      "Create a 45-minute agenda for the Meridian operations review: five minutes for safety metrics led by Jo, fifteen minutes for fulfillment performance led by Karim, fifteen minutes for the carrier decision led by Rosa, and ten minutes for actions and owners. Note that the carrier insurance certificate is still pending and cannot be treated as approved.",
    expectedOutput: {
      deliverable: "agenda",
      mustInclude: ["45 total minutes", "all four timed sections", "Jo", "Karim", "Rosa", "insurance certificate pending"],
      mustNot: ["treat the certificate as approved", "exceed 45 minutes"],
      validation: [],
    },
    tags: ["constraint-following", "agenda", "frozen-eval"],
  },
];
