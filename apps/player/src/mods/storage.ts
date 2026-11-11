const databaseName = "tm4-rewired-mods";

// Persist only user-supplied mod packages; disc resources never enter this database.
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("packages");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Mod storage failed"));
    request.onblocked = () => reject(new Error("Close other Rewired tabs to update mod storage"));
  });
}
export async function savedPackages(): Promise<Uint8Array<ArrayBuffer>[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("packages").objectStore("packages").getAll();
      request.onsuccess = () => resolve(request.result as Uint8Array<ArrayBuffer>[]);
      request.onerror = () => reject(request.error ?? new Error("Mod storage failed"));
    });
  } finally {
    db.close();
  }
}
export async function savePackages(
  packages: readonly { manifest: { id: string }; bytes: Uint8Array<ArrayBuffer> }[],
) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("packages", "readwrite");
      const store = tx.objectStore("packages");
      store.clear();
      for (const p of packages) store.put(p.bytes, p.manifest.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Mod storage transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Saving mods was cancelled"));
    });
  } finally {
    db.close();
  }
}
