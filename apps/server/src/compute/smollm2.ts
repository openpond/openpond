export const SMOLLM2_MODEL = {
  id: "HuggingFaceTB/SmolLM2-135M-Instruct",
  revision: "12fd25f77366fa6b3b4b768ec3050bf629380bac",
  tokenizerRevision: "12fd25f77366fa6b3b4b768ec3050bf629380bac",
  chatTemplateHash: "872be49dbb638044ad01b60388f48d469ff2980e5f0dccdc22ec907db54d0788",
  license: "Apache-2.0",
  expectedBytes: 272_437_573,
  weightSha256: "5af571cbf074e6d21a03528d2330792e532ca608f24ac70a143f6b369968ab8c",
  parameterCount: 135_000_000,
  architecture: "LlamaForCausalLM",
  targetModules: ["q_proj", "v_proj"],
} as const;
