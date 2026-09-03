// ── Client-side file byte cache ─────────────────────────────────────────────
// Caches downloaded file buffers (keyed by terminal url + optional variant +
// path) so reopening the same file does not re-download it from the terminal
// server. Consumers that hand buffers to pdf.js must pass a *copy* (pdf.js
// transfers/detaches the buffer it receives) — the cached master never gets
// detached. Least-recently-used entries are evicted over a total budget.

const MAX_FILE_CACHE_BYTES = 1024 * 1024 * 1024; // 1 GB

const fileBufferCache = new Map<string, { buffer: ArrayBuffer; at: number }>();
let fileBufferCacheBytes = 0;

export const fileCacheKey = (baseUrl: string, path: string, variant = '') =>
	`${baseUrl}|${variant}|${path}`;

export const getCachedFileBuffer = (key: string): ArrayBuffer | null => {
	const entry = fileBufferCache.get(key);
	if (!entry) return null;
	entry.at = Date.now(); // LRU touch
	return entry.buffer;
};

export const storeFileBuffer = (key: string, buffer: ArrayBuffer): void => {
	if (fileBufferCache.has(key)) return;

	fileBufferCache.set(key, { buffer, at: Date.now() });
	fileBufferCacheBytes += buffer.byteLength;

	while (fileBufferCacheBytes > MAX_FILE_CACHE_BYTES && fileBufferCache.size > 0) {
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key_, entry] of fileBufferCache) {
			if (entry.at < oldestAt) {
				oldestAt = entry.at;
				oldestKey = key_;
			}
		}
		if (!oldestKey) break;
		fileBufferCacheBytes -= fileBufferCache.get(oldestKey)!.buffer.byteLength;
		fileBufferCache.delete(oldestKey);
	}
};

/** Drop cached buffers for a path (e.g. after write_file changed the file). */
export const invalidateFileBuffers = (path: string): void => {
	const suffix = `|${path}`;
	for (const key of Array.from(fileBufferCache.keys())) {
		if (key.endsWith(suffix)) {
			fileBufferCacheBytes -= fileBufferCache.get(key)!.buffer.byteLength;
			fileBufferCache.delete(key);
		}
	}
};
