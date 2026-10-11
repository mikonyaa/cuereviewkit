import type { Session } from "../review/types";
export const DB_NAME = "cuereviewkit-v1";
interface RecordValue {
  token: string;
  session: Session;
  savedAt: string;
}
export async function openRecovery(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("sessions"))
        r.result.createObjectStore("sessions");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB unavailable."));
    r.onblocked = () =>
      reject(new Error("Recovery database upgrade blocked by another tab."));
  });
}
export async function loadRecovery(): Promise<RecordValue | null> {
  const db = await openRecovery();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly"),
      r = tx.objectStore("sessions").get("current");
    let value: RecordValue | null = null;
    r.onsuccess = () => {
      value = r.result ?? null;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Recovery read failed."));
    };
  });
}
export async function saveRecovery(
  session: Session,
  expectedToken: string | null,
): Promise<string> {
  const db = await openRecovery();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite"),
      store = tx.objectStore("sessions"),
      get = store.get("current");
    const token = crypto.randomUUID();
    let conflict = false;
    get.onsuccess = () => {
      const existing = get.result as RecordValue | undefined;
      if ((existing?.token ?? null) !== expectedToken) {
        conflict = true;
        tx.abort();
        return;
      }
      store.put(
        {
          token,
          session,
          savedAt: new Date().toISOString(),
        } satisfies RecordValue,
        "current",
      );
    };
    tx.oncomplete = () => {
      db.close();
      resolve(token);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(
        new Error(
          conflict
            ? "Storage conflict: another tab saved a newer recovery. Download a package; this tab will not overwrite it."
            : `Autosave failed: ${tx.error?.message ?? "transaction aborted"}. Download a package for backup.`,
        ),
      );
    };
  });
}
