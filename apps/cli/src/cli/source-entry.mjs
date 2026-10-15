#!/usr/bin/env node
// The desktop source runtime uses the same CLI entry and argv as the bundle.
import { register } from "tsx/esm/api";

register();
await import("./main.ts");
