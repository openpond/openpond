# Invoice extraction starter

This original package contains 80 synthetic plain-text invoices: 40 training, 20 validation and 20 frozen-evaluation tasks. Entire customer families stay in one split. Cases vary quantities, prices, currency, tax and missing fields. The package does not perform OCR.

The task format defines the model instructions and structured JSON output. Its Reward contains an actual isolated JavaScript verifier, comparing every field with reference data generated alongside the original invoices. Missing totals remain unknown even when they could be calculated. No expected outputs are placed in the policy-visible context.

Build the integrity-checked package with `pnpm exec tsx examples/training/invoice-extraction/build.mts` after building the SDK. The generated artifact is written to `artifacts/model-starters/invoice-extractor.json`. The recipe uses the public `openpond-sdk/model-starters` entrypoint introduced in SDK 0.1.7.

`packages/sdk/test/invoice-starter.test.ts` executes the verifier for every correct reference and corrupted invoice number, plus invented totals in every missing-total case. Package boundary tests reject dependency substitution, changed executable graders, schema-invalid examples and split contamination.

This is an authored package, not a trained model or qualified starter. Catalog publication, idempotent user creation, recorded baseline/training/evaluation receipts, and the complete Desktop journey remain pending. The manifest's evidence references remain null until those operations produce actual results. The synthetic task count is a starting fixture set, not evidence that training improves performance.
