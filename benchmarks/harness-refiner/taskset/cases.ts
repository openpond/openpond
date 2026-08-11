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
    id: "adaptation-invoice-correction-email",
    clusterKey: "northwind-invoice-correction-message",
    split: "validation",
    prompt:
      "Draft a courteous email to Northwind Labs explaining that invoice INV-1842 incorrectly lists 120 seats instead of 102. A corrected invoice will arrive by August 14, no payment is due until it arrives, and billing questions should go to accounts@example.com. Keep it under 130 words and do not suggest the error was intentional.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["complete send-ready message copy", "INV-1842", "120 seats instead of 102", "August 14", "no payment due until corrected", "accounts@example.com"],
      mustNot: ["suggest the error was intentional", "exceed 130 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "adaptation"],
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
    id: "adaptation-workshop-reschedule-email",
    clusterKey: "juniper-workshop-reschedule-message",
    split: "validation",
    prompt:
      "Draft a warm email to Juniper workshop registrants explaining that the September 3 session is moving to September 10 at 2:00 p.m. ET because the facilitator is unavailable. Existing registrations carry over, a recording will be shared, and questions should go to events@example.com. Keep it under 120 words and do not imply the venue caused the change.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["complete send-ready message copy", "September 10", "2:00 p.m. ET", "facilitator unavailable", "registrations carry over", "recording", "events@example.com"],
      mustNot: ["blame the venue", "exceed 120 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "adaptation"],
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
      mustInclude: ["complete send-ready message copy", "August 27", "accessibility testing incomplete", "August 22 expectation", "pilot access remains", "support email"],
      mustNot: ["say testing failed", "exceed 140 words", "invent compensation", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "adaptation"],
  },
  {
    id: "adaptation-service-window-email",
    clusterKey: "cirrus-service-window-message",
    split: "validation",
    prompt:
      "Draft a calm email to Cirrus customers about planned maintenance on August 18 from 1:00 to 2:00 UTC. The dashboard will be read-only, alerts will continue, no data loss is expected, and updates will appear at status.example.com. Keep it under 125 words and do not promise that there will be zero interruption.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["complete send-ready message copy", "August 18", "1:00 to 2:00 UTC", "dashboard read-only", "alerts continue", "no data loss expected", "status.example.com"],
      mustNot: ["promise zero interruption", "exceed 125 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "adaptation"],
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
    id: "frozen-shipping-delay-chat-message",
    clusterKey: "beacon-shipping-delay-message",
    split: "frozen_eval",
    prompt:
      "Write a concise team chat message explaining that the Beacon equipment shipment is now expected August 21 instead of August 19 because the carrier missed its transfer window. The installation crew remains booked for August 22, Morgan owns the carrier follow-up, and the team should flag conflicts in the logistics channel. Keep it under 90 words and do not say the equipment is lost.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["complete ready-to-post message copy", "August 21", "carrier missed transfer window", "August 22 installation", "Morgan", "logistics channel"],
      mustNot: ["say the equipment is lost", "exceed 90 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "frozen-eval"],
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
    id: "frozen-refund-support-reply",
    clusterKey: "cobalt-refund-support-message",
    split: "frozen_eval",
    prompt:
      "Write a helpful support reply to a Cobalt customer whose duplicate $48 charge is being reviewed. The review should finish by August 16, any confirmed duplicate will be refunded to the original payment method within five business days, and the case number is CB-7714. Keep it under 110 words and do not state that the refund has already been approved.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["complete send-ready reply copy", "$48 duplicate charge", "August 16", "original payment method", "five business days", "CB-7714"],
      mustNot: ["state the refund is already approved", "exceed 110 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "frozen-eval"],
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
      mustInclude: ["complete send-ready message copy", "July 28", "August 1 inspection", "security concern", "repair date within two business days"],
      mustNot: ["make a legal threat", "claim facts not supplied", "exceed 130 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "frozen-eval"],
  },
  {
    id: "frozen-vendor-document-followup-email",
    clusterKey: "meridian-vendor-document-message",
    split: "frozen_eval",
    prompt:
      "Draft a firm but professional email to Meridian Freight following up on the insurance certificate promised for August 7. It has not arrived, carrier onboarding cannot finish without it, and Rosa needs the document or a confirmed delivery date by August 12. Keep it under 120 words and do not threaten to cancel the contract.",
    expectedOutput: {
      deliverable: "message",
      mustInclude: ["complete send-ready message copy", "insurance certificate", "August 7", "onboarding blocked", "Rosa", "August 12"],
      mustNot: ["threaten contract cancellation", "exceed 120 words", "return only a checklist or file path instead of the message"],
      validation: [],
    },
    tags: ["constraint-following", "direct-deliverable", "communication", "frozen-eval"],
  },
];
