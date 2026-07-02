# openpond

## 0.5.3

### Patch Changes

- 812a6dc: fixed env and added mroe sandbox stuff

## 0.5.2

### Patch Changes

- 9f9094a: Remove managed database declarations from the sandbox template and sandbox create/fork request contracts. Templates should use durable volumes with SQLite or files for structured sandbox state.

  Add `openpond sandbox-template start` so template authors can validate the current manifest, sync the local repo through OpenPond Git, create a sandbox with declared resources and volumes, upload declared file inputs, and run the selected start/action/service command with replay params.

## 0.5.1

### Patch Changes

- 2281254: renamed yaml file

## 0.5.0

### Minor Changes

- 74a6833: added sandboxes

## 0.4.0

### Minor Changes

- f5646cb: added balances

## 0.3.5

### Patch Changes

- bf8b0e6: added more agent controls

## 0.3.4

### Patch Changes

- 36f0422: added chat

## 0.3.3

### Patch Changes

- 37b3a33: fixed missing listappschedles

## 0.3.2

### Patch Changes

- 5c9db6b: fixed account active

## 0.3.1

### Patch Changes

- 32ae02a: api base url
- 32ae02a: Add profile-specific API base URL config and remove hardcoded non-production endpoint mappings from the CLI/runtime bundle.

## 0.3.0

### Minor Changes

- bb4018e: updated docs

## 0.2.4

### Patch Changes

- 4cac928: Add public account, API health, and redacted local profile config helpers.

## 0.2.3

### Patch Changes

- 59a2c17: remove cli device code login

## 0.2.2

### Patch Changes

- 0212347: added version command

## 0.2.1

### Patch Changes

- d1479e9: updated base url

## 0.2.0

### Minor Changes

- b6e5f07: added multi accounts

## 0.1.4

### Patch Changes

- bb79cf8: cleaned up naming

## 0.1.3

### Patch Changes

- 96cbdc6: depreciated templateid

## 0.1.2

### Patch Changes

- 176a699: updated endpoints

## 0.1.1

### Patch Changes

- 05f2e19: testing github push

## 0.1.0

- Initial release of the API key CLI.
