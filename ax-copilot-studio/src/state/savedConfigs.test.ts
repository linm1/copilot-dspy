import { beforeEach, describe, expect, it } from "vitest";
import { SavedRunConfig } from "../types";
import { InMemoryMemento, SavedConfigsStore } from "./savedConfigs";

function makeConfig(overrides: Partial<SavedRunConfig> = {}): SavedRunConfig {
  return {
    name: "Summarizer",
    signatureString: "documentText:string -> summary:string, keyPoints:string",
    module: "Predict",
    model: "gpt-5-mini",
    enabledTools: [],
    ...overrides,
  };
}

describe("SavedConfigsStore", () => {
  let memento: InMemoryMemento;
  let store: SavedConfigsStore;

  beforeEach(() => {
    memento = new InMemoryMemento();
    store = new SavedConfigsStore(memento);
  });

  it("returns an empty list when nothing has been saved", () => {
    expect(store.list()).toEqual([]);
  });

  it("saves a config and lists it back", async () => {
    const config = makeConfig();
    await store.save(config);
    expect(store.list()).toEqual([config]);
  });

  it("round-trips save -> load by name", async () => {
    const config = makeConfig({ name: "QA" });
    await store.save(config);
    expect(store.get("QA")).toEqual(config);
  });

  it("returns undefined for a name that was never saved", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("overwrites an existing config with the same name", async () => {
    await store.save(makeConfig({ model: "gpt-4o" }));
    await store.save(makeConfig({ model: "gpt-5-mini" }));

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].model).toBe("gpt-5-mini");
  });

  it("preserves save order across multiple distinct configs", async () => {
    await store.save(makeConfig({ name: "First" }));
    await store.save(makeConfig({ name: "Second" }));
    await store.save(makeConfig({ name: "Third" }));

    expect(store.list().map((c) => c.name)).toEqual(["First", "Second", "Third"]);
  });

  it("deletes a config by name", async () => {
    await store.save(makeConfig({ name: "ToDelete" }));
    await store.save(makeConfig({ name: "ToKeep" }));

    await store.delete("ToDelete");

    expect(store.list().map((c) => c.name)).toEqual(["ToKeep"]);
    expect(store.get("ToDelete")).toBeUndefined();
  });

  it("deleting a non-existent name is a no-op", async () => {
    await store.save(makeConfig({ name: "Keep" }));
    await store.delete("never-existed");
    expect(store.list().map((c) => c.name)).toEqual(["Keep"]);
  });

  it("persists enabledTools and module/model fields exactly", async () => {
    const config = makeConfig({
      name: "ReActDemo",
      module: "ReAct",
      enabledTools: ["readFile", "fetchUrl"],
    });
    await store.save(config);
    expect(store.get("ReActDemo")).toEqual(config);
  });

  it("survives reconstruction of the store over the same memento (persistence semantics)", async () => {
    await store.save(makeConfig({ name: "Persisted" }));

    const reopened = new SavedConfigsStore(memento);
    expect(reopened.list().map((c) => c.name)).toEqual(["Persisted"]);
  });
});
