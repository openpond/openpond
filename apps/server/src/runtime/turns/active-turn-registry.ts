import type { ActiveTurn } from "./ports.js";
import { KeyedRegistry } from "./keyed-registry.js";

export class ActiveTurnRegistry extends KeyedRegistry<ActiveTurn> {
  constructor() {
    super("active turn");
  }
}
