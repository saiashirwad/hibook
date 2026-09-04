import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { prepareExecution } from "../compiler/fast-prepare";
import type { Cell, NotebookDocument } from "../model/types";
import {
  IndexedDbNotebookCache,
  NOTEBOOK_CACHE_STORE_NAME,
} from "./indexeddb";

function notebook(index: number): NotebookDocument {
  const root: Cell = {
    id: "root",
    name: "root",
    kind: "text",
    source: "Notebook",
    classes: [],
    metadata: {},
    children: ["code"],
  };
  const code: Cell = {
    id: "code",
    name: "code",
    kind: "javascript",
    source: `$(() => ${index})`,
    classes: [],
    metadata: {},
    children: [],
  };
  return { rootId: root.id, cells: { root, code } };
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function opened(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("IndexedDB notebook cache", () => {
  it("upgrades an empty database, writes and loads exact records, and deletes corrupt hits", async () => {
    const factory = new IDBFactory();
    const name = "cache-load-write";
    const cache = new IndexedDbNotebookCache({
      factory,
      databaseName: name,
      now: () => 10,
    });
    const document = notebook(1);
    const saved = await cache.save(
      document,
      prepareExecution(document),
      [["code", { value: 1 }]],
    );
    await expect(cache.load(document)).resolves.toEqual(saved);

    const database = await opened(factory.open(name, 1));
    const write = database.transaction(NOTEBOOK_CACHE_STORE_NAME, "readwrite");
    write.objectStore(NOTEBOOK_CACHE_STORE_NAME).put({
      ...saved,
      compatibility: "incompatible",
    });
    await completed(write);
    await expect(cache.load(document)).resolves.toBeUndefined();

    const read = database.transaction(NOTEBOOK_CACHE_STORE_NAME, "readonly");
    const missing = result(
      read.objectStore(NOTEBOOK_CACHE_STORE_NAME).get(saved.revision),
    );
    await completed(read);
    await expect(missing).resolves.toBeUndefined();
    database.close();
    cache.dispose();
  });

  it("retains only the eight newest exact revisions", async () => {
    const factory = new IDBFactory();
    let now = 0;
    const cache = new IndexedDbNotebookCache({
      factory,
      databaseName: "cache-pruning",
      now: () => ++now,
    });
    const documents = Array.from({ length: 9 }, (_, index) => notebook(index));
    for (const document of documents) {
      await cache.save(document, prepareExecution(document), [["code", now]]);
    }

    await expect(cache.load(documents[0]!)).resolves.toBeUndefined();
    for (const document of documents.slice(1)) {
      await expect(cache.load(document)).resolves.toBeDefined();
    }
    cache.dispose();
  });

  it("closes its live connection when a database version change is requested", async () => {
    const factory = new IDBFactory();
    const name = "cache-version-change";
    const cache = new IndexedDbNotebookCache({ factory, databaseName: name });
    const document = notebook(1);
    await cache.save(document, prepareExecution(document), []);

    const upgrade = factory.open(name, 2);
    upgrade.onupgradeneeded = () => {
      upgrade.result.createObjectStore("future");
    };
    const upgraded = await opened(upgrade);
    expect(upgraded.objectStoreNames.contains("future")).toBe(true);
    upgraded.close();
    cache.dispose();
  });
});
