import type { PreparedNotebook } from "../compiler/protocol";
import type { CellId, NotebookDocument } from "../model/types";
import {
  NOTEBOOK_CACHE_REVISION_LIMIT,
  createNotebookCacheRecord,
  validateNotebookCacheRecord,
} from "./record";
import type { NotebookCacheRecord } from "./record";

export const NOTEBOOK_CACHE_DATABASE_NAME = "hibook-notebook-cache";
export const NOTEBOOK_CACHE_DATABASE_VERSION = 1;
export const NOTEBOOK_CACHE_STORE_NAME = "revisions";

export interface NotebookCache {
  load(document: NotebookDocument): Promise<NotebookCacheRecord | undefined>;
  save(
    document: NotebookDocument,
    prepared: PreparedNotebook,
    runtimeValues: Iterable<readonly [CellId, unknown]>,
  ): Promise<NotebookCacheRecord>;
  dispose(): void;
}

export interface IndexedDbNotebookCacheOptions {
  readonly factory?: IDBFactory;
  readonly now?: () => number;
  readonly databaseName?: string;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}
function pruneOldRecords(store: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onerror = () =>
      reject(request.error ?? new Error("Reading cache records failed"));
    request.onsuccess = () => {
      const ordered: Array<{ revision: string; savedAt: number }> = [];
      for (const candidate of request.result as unknown[]) {
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          !("revision" in candidate) ||
          typeof candidate.revision !== "string"
        ) {
          continue;
        }
        ordered.push({
          revision: candidate.revision,
          savedAt:
            "savedAt" in candidate &&
            typeof candidate.savedAt === "number" &&
            Number.isFinite(candidate.savedAt)
              ? candidate.savedAt
              : Number.NEGATIVE_INFINITY,
        });
      }
      ordered.sort((left, right) => {
        const byTime = right.savedAt - left.savedAt;
        if (byTime !== 0) return byTime;
        return left.revision < right.revision
          ? -1
          : left.revision > right.revision
            ? 1
            : 0;
      });
      for (const stale of ordered.slice(NOTEBOOK_CACHE_REVISION_LIMIT)) {
        store.delete(stale.revision);
      }
      resolve();
    };
  });
}


export class IndexedDbNotebookCache implements NotebookCache {
  readonly #factory: IDBFactory;
  readonly #now: () => number;
  readonly #databaseName: string;
  #database: IDBDatabase | undefined;
  #opening: Promise<IDBDatabase> | undefined;
  #disposed = false;

  constructor(options: IndexedDbNotebookCacheOptions = {}) {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is unavailable");
    this.#factory = factory;
    this.#now = options.now ?? Date.now;
    this.#databaseName = options.databaseName ?? NOTEBOOK_CACHE_DATABASE_NAME;
  }

  async load(document: NotebookDocument): Promise<NotebookCacheRecord | undefined> {
    const database = await this.#open();
    const revision = JSON.stringify(document);
    const transaction = database.transaction(NOTEBOOK_CACHE_STORE_NAME, "readonly");
    const request = transaction.objectStore(NOTEBOOK_CACHE_STORE_NAME).get(revision);
    const [raw] = await Promise.all([requestResult(request), transactionDone(transaction)]);
    const record = validateNotebookCacheRecord(raw, document);
    if (record) return record;
    if (raw !== undefined) {
      try {
        await this.#delete(revision);
      } catch {
        // A malformed record is still a miss when best-effort cleanup fails.
      }
    }
    return undefined;
  }

  async save(
    document: NotebookDocument,
    prepared: PreparedNotebook,
    runtimeValues: Iterable<readonly [CellId, unknown]>,
  ): Promise<NotebookCacheRecord> {
    const record = createNotebookCacheRecord(
      document,
      prepared,
      runtimeValues,
      this.#now(),
    );
    const database = await this.#open();
    const transaction = database.transaction(NOTEBOOK_CACHE_STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(NOTEBOOK_CACHE_STORE_NAME);
    store.put(record);
    await Promise.all([pruneOldRecords(store), done]);
    return record;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#database?.close();
    this.#database = undefined;
    this.#opening = undefined;
  }

  async #delete(revision: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(NOTEBOOK_CACHE_STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(NOTEBOOK_CACHE_STORE_NAME).delete(revision);
    await done;
  }

  #open(): Promise<IDBDatabase> {
    if (this.#disposed) return Promise.reject(new Error("Notebook cache has been disposed"));
    if (this.#database) return Promise.resolve(this.#database);
    if (this.#opening) return this.#opening;

    this.#opening = new Promise((resolve, reject) => {
      const request = this.#factory.open(
        this.#databaseName,
        NOTEBOOK_CACHE_DATABASE_VERSION,
      );
      let settled = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(NOTEBOOK_CACHE_STORE_NAME)) {
          database.createObjectStore(NOTEBOOK_CACHE_STORE_NAME, {
            keyPath: "revision",
          });
        }
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        this.#opening = undefined;
        reject(new Error("Opening the notebook cache was blocked"));
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        this.#opening = undefined;
        reject(request.error ?? new Error("Opening the notebook cache failed"));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled || this.#disposed) {
          database.close();
          if (!settled) {
            settled = true;
            this.#opening = undefined;
            reject(new Error("Notebook cache has been disposed"));
          }
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          if (this.#database === database) this.#database = undefined;
          this.#opening = undefined;
        };
        this.#database = database;
        resolve(database);
      };
    });
    return this.#opening;
  }
}
