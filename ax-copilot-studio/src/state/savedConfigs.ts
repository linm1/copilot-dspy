/**
 * Persists named run configurations (`{ name, signatureString, module, model,
 * enabledTools }`) via an injected Memento-like store -- `context.globalState`
 * in production, an in-memory fake in unit tests. No secrets live here (the
 * OAuth/session tokens are owned by src/auth/tokenStore.ts).
 *
 * Real callers inject `vscode.Memento` (via `context.globalState`); this
 * module never imports `vscode` directly so it stays unit-testable.
 */

import { SavedRunConfig } from "../types";

/** Minimal slice of vscode.Memento this module depends on. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** In-memory fake for unit tests; mirrors vscode.Memento's sync-get/async-update contract. */
export class InMemoryMemento implements MementoLike {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

const STORAGE_KEY = "axCopilot.savedConfigs";

export class SavedConfigsStore {
  constructor(private readonly memento: MementoLike) {}

  /** List all saved configs, in save order. */
  list(): SavedRunConfig[] {
    return this.memento.get<SavedRunConfig[]>(STORAGE_KEY, []);
  }

  /** Look up a single saved config by name, or undefined if not found. */
  get(name: string): SavedRunConfig | undefined {
    return this.list().find((config) => config.name === name);
  }

  /** Save a new config or overwrite an existing one with the same name. */
  async save(config: SavedRunConfig): Promise<void> {
    const existing = this.list();
    const index = existing.findIndex((c) => c.name === config.name);
    const next =
      index >= 0
        ? existing.map((c, i) => (i === index ? config : c))
        : [...existing, config];
    await this.memento.update(STORAGE_KEY, next);
  }

  /** Delete a saved config by name. No-op if it doesn't exist. */
  async delete(name: string): Promise<void> {
    const next = this.list().filter((c) => c.name !== name);
    await this.memento.update(STORAGE_KEY, next);
  }
}
