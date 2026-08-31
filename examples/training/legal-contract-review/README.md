# Legal contract review Taskset example

This directory is example data and authoring code, not a legal-specific OpenPond
API. It pins the public Harvey LAB repository, maps selected matters into the
generic OpenPond Taskset contract, and emits a portable Taskset package.

Build the package:

```sh
pnpm tsx examples/training/legal-contract-review/build.ts \
  --output-dir ./tmp/legal-contract-review-week0 \
  --release-stage week0
```

Import it into the running local OpenPond app:

```sh
pnpm cli:dev taskset import ./tmp/legal-contract-review-week0 --profile default
```

After import, publish the Taskset and create or update a Model Project in the
OpenPond UI. The Model Project is the durable source of the selected Taskset,
base model, training method, recipe, destination, spend cap, and retention
settings. Launch from that saved Model Project in the UI, or use the generic
`openpond training start <model-project-id>` command. This example never writes
OpenPond's SQLite database, reads the local capability token, or starts paid
training itself.
