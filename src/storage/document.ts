import type { NotebookDocument } from "../model/types";
import { validateNotebook } from "../model/validate";

export interface SavedNotebook {
  readonly formatVersion: 1;
  readonly document: NotebookDocument;
  readonly executionEnabled: boolean;
}

const DATABASE = "hibook-documents";
const STORE = "documents";

export function parseNotebook(input: unknown): SavedNotebook {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Not a HiBook document.");
  }
  const record = input as Record<string, unknown>;
  if (record.formatVersion !== 1) {
    throw new Error("Unsupported HiBook document version.");
  }
  const validation = validateNotebook(record.document);
  if (!validation.valid) {
    throw new Error(`Invalid notebook: ${validation.diagnostics[0]?.message ?? "unknown error"}`);
  }
  if (typeof record.executionEnabled !== "boolean") {
    throw new Error("Invalid execution setting.");
  }
  // Own a plain JSON snapshot; do not retain objects supplied by an import or IndexedDB.
  return JSON.parse(JSON.stringify(record)) as SavedNotebook;
}

export function exportNotebook(document: NotebookDocument): string {
  return JSON.stringify({ formatVersion: 1, document, executionEnabled: false }, null, 2);
}

export class DocumentStore {
  #database: Promise<IDBDatabase> | undefined;
  #pending: Promise<void> = Promise.resolve();

  #open(): Promise<IDBDatabase> {
    if (!this.#database) {
      this.#database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE);
          }
        };
        request.onerror = () => reject(request.error ?? new Error("Cannot open notebook storage"));
        request.onsuccess = () => resolve(request.result);
      });
      this.#database = this.#database.catch((error: unknown) => {
        this.#database = undefined;
        throw error;
      });
    }
    return this.#database;
  }

  async load(): Promise<SavedNotebook | undefined> {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get("current");
      request.onerror = () => reject(request.error ?? new Error("Cannot read notebook"));
      request.onsuccess = () => {
        try {
          resolve(request.result === undefined ? undefined : parseNotebook(request.result));
        } catch (error) {
          reject(error);
        }
      };
    });
  }

  save(record: SavedNotebook): Promise<void> {
    const snapshot = parseNotebook(record);
    const write = this.#pending.catch(() => undefined).then(async () => {
      const db = await this.#open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(snapshot, "current");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Cannot save notebook"));
        transaction.onabort = () => reject(transaction.error ?? new Error("Notebook save aborted"));
      });
    });
    this.#pending = write;
    return write;
  }
}
