// ── Client-side file byte cache (memory + IndexedDB) ────────────────────────
// Caches downloaded file buffers (keyed by terminal url + optional variant +
// path) so reopening the same file does not re-download it from the terminal
// server. The hot copy lives in memory for the current session; everything is
// ALSO written through to IndexedDB ("owui-pdf-cache") so it survives page
// reloads and is inspectable in Chrome DevTools → Application → IndexedDB.
// Consumers that hand buffers to pdf.js must pass a *copy* (pdf.js
// transfers/detaches the buffer it receives) — the cached master never gets
// detached. Least-recently-used entries are evicted over a total budget.

export const IDB_NAME = 'owui-pdf-cache';
export const IDB_VERSION = 1;
export const IDB_STORE_FILES = 'files';
export const IDB_STORE_RENDERS = 'renders';

const MAX_FILE_CACHE_BYTES = 1024 * 1024 * 1024; // 1 GB

const fileBufferCache = new Map<string, { buffer: ArrayBuffer; at: number }>();
let fileBufferCacheBytes = 0;

// Maps a PDF byte buffer to its file-cache key so shared document/render
// caches can be keyed consistently across multiple viewer elements that all
// receive the same ArrayBuffer reference.
const dataKeyMap = new WeakMap<ArrayBuffer | Uint8Array, string>();
export const rememberFileKey = (data: ArrayBuffer | Uint8Array, key: string): void => {
	dataKeyMap.set(data, key);
};
export const findFileKey = (data: ArrayBuffer | Uint8Array): string | undefined =>
	dataKeyMap.get(data);

// ── IndexedDB plumbing (failures degrade silently to memory-only) ───────────
let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(IDB_NAME, IDB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(IDB_STORE_FILES)) {
					db.createObjectStore(IDB_STORE_FILES);
				}
				if (!db.objectStoreNames.contains(IDB_STORE_RENDERS)) {
					db.createObjectStore(IDB_STORE_RENDERS);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		dbPromise.catch(() => {
			dbPromise = null;
		});
	}
	return dbPromise;
};

export const idbGetRecord = async <T>(store: string, key: string): Promise<T | undefined> => {
	try {
		const db = await openDb();
		return await new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(store, 'readonly');
			const request = tx.objectStore(store).get(key);
			request.onsuccess = () => resolve(request.result as T | undefined);
			request.onerror = () => reject(request.error);
		});
	} catch {
		return undefined;
	}
};

export const idbPutRecord = async (store: string, key: string, value: unknown): Promise<void> => {
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).put(value, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} catch {
		// Storage unavailable / quota exceeded — memory cache still works.
	}
};

export const idbDeleteRecord = async (store: string, key: string): Promise<void> => {
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} catch {
		// ignore
	}
};

/** Delete every record whose key starts with `prefix`, except `keepKey`. */
export const idbDeletePrefix = async (
	store: string,
	prefix: string,
	keepKey?: string
): Promise<void> => {
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(store, 'readwrite');
			const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
			const cursorRequest = tx.objectStore(store).openCursor(range);
			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (!cursor) return;
				if (cursor.key !== keepKey) cursor.delete();
				cursor.continue();
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} catch {
		// ignore
	}
};

// ── Public API ──────────────────────────────────────────────────────────────

export const fileCacheKey = (baseUrl: string, path: string, variant = '') =>
	`${baseUrl}|${variant}|${path}`;

/** Memory-only lookup (instant, synchronous). */
export const getCachedFileBuffer = (key: string): ArrayBuffer | null => {
	const entry = fileBufferCache.get(key);
	if (!entry) return null;
	entry.at = Date.now();
	return entry.buffer;
};

/** Memory + IndexedDB lookup. Returns the master buffer (never to be detached). */
export const loadCachedFileBuffer = async (key: string): Promise<ArrayBuffer | null> => {
	const memoryEntry = fileBufferCache.get(key);
	if (memoryEntry) {
		memoryEntry.at = Date.now();
		return memoryEntry.buffer;
	}

	const record = await idbGetRecord<{ blob: Blob; size: number; at: number }>(
		IDB_STORE_FILES,
		key
	);
	if (!record?.blob) return null;

	const buffer = await record.blob.arrayBuffer();
	fileBufferCache.set(key, { buffer, at: Date.now() });
	fileBufferCacheBytes += buffer.byteLength;
	return buffer;
};

/** Write-through: hot memory copy + IndexedDB (persists across reloads). */
export const storeFileBuffer = async (key: string, buffer: ArrayBuffer): Promise<void> => {
	if (!fileBufferCache.has(key)) {
		fileBufferCache.set(key, { buffer, at: Date.now() });
		fileBufferCacheBytes += buffer.byteLength;
	}

	await idbPutRecord(IDB_STORE_FILES, key, {
		blob: new Blob([buffer]),
		size: buffer.byteLength,
		at: Date.now()
	});

	if (fileBufferCacheBytes > MAX_FILE_CACHE_BYTES) {
		await pruneFileCache();
	}
};

const pruneFileCache = async () => {
	try {
		const db = await openDb();
		const entries: { key: string; size: number; at: number }[] = [];
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE_FILES, 'readonly');
			const cursorRequest = tx.objectStore(IDB_STORE_FILES).openCursor();
			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (!cursor) return;
				const value = cursor.value as { size?: number; at?: number };
				entries.push({ key: String(cursor.key), size: value?.size ?? 0, at: value?.at ?? 0 });
				cursor.continue();
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});

		entries.sort((a, b) => a.at - b.at);
		let total = entries.reduce((sum, entry) => sum + entry.size, 0);
		for (const entry of entries) {
			if (total <= MAX_FILE_CACHE_BYTES) break;
			total -= entry.size;
			await idbDeleteRecord(IDB_STORE_FILES, entry.key);
			const memoryEntry = fileBufferCache.get(entry.key);
			if (memoryEntry) {
				fileBufferCacheBytes -= memoryEntry.buffer.byteLength;
				fileBufferCache.delete(entry.key);
			}
		}
	} catch {
		// ignore
	}
};

/** Drop cached buffers for a path (e.g. after write_file changed the file). */
export const invalidateFileBuffers = async (path: string): Promise<void> => {
	const suffix = `|${path}`;
	for (const key of Array.from(fileBufferCache.keys())) {
		if (key.endsWith(suffix)) {
			fileBufferCacheBytes -= fileBufferCache.get(key)!.buffer.byteLength;
			fileBufferCache.delete(key);
		}
	}

	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE_FILES, 'readwrite');
			const cursorRequest = tx.objectStore(IDB_STORE_FILES).openCursor();
			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (!cursor) return;
				if (String(cursor.key).endsWith(suffix)) cursor.delete();
				cursor.continue();
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});

		// Drop persisted rendered pages for this path as well.
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE_RENDERS, 'readwrite');
			const cursorRequest = tx.objectStore(IDB_STORE_RENDERS).openCursor();
			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (!cursor) return;
				if (String(cursor.key).includes(`|${path}|p`)) cursor.delete();
				cursor.continue();
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} catch {
		// ignore
	}
};
