import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Static pdf.js resources (standard fonts, cmaps, wasm binaries) are copied next
// to the app bundle by vite-plugin-static-copy (see vite.config.ts). Providing
// them to getDocument() removes the "standardFontDataUrl" warnings and enables
// correct standard font / CMap fallbacks instead of failing per page.
export const PDF_DOCUMENT_OPTIONS = {
	standardFontDataUrl: '/pdfjs/standard_fonts/',
	cMapUrl: '/pdfjs/cmaps/',
	cMapPacked: true,
	wasmUrl: '/pdfjs/wasm/',
	// Errors only: pdf.js otherwise logs a warning per page for benign issues
	// (unknown annotation types, missing standard fonts, etc.) which spams the
	// console on large scanned documents.
	verbosity: 0
};

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

/**
 * Dynamically import pdf.js once and make sure the worker is configured.
 * All PDF viewers share this so GlobalWorkerOptions is only ever set once.
 */
export const loadPdfJs = () => {
	if (!pdfjsPromise) {
		pdfjsPromise = import('pdfjs-dist')
			.then((pdfjs) => {
				pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
				return pdfjs;
			})
			.catch((error) => {
				// Don't cache failures so a retry can succeed.
				pdfjsPromise = null;
				throw error;
			});
	}
	return pdfjsPromise;
};

// ── Shared parsed-document cache (module level — outside any component) ────
// Parsing a large PDF (900+ pages) is expensive; every display_file preview
// creates a NEW viewer element, so the parsed document must live outside the
// component. Documents are refcounted: viewer + thumbnail instances each hold
// a reference; when the last reference is released the document stays cached
// (LRU, max 3) so reopening the same file is instant, and is only destroyed
// once it is evicted AND unused.

import type { PDFDocumentProxy } from 'pdfjs-dist';

type SharedDocEntry = { doc: PDFDocumentProxy; refs: number; at: number };
const docCache = new Map<string, SharedDocEntry>();
const pendingDocs = new Map<string, Promise<PDFDocumentProxy>>();
const MAX_CACHED_DOCS = 3;

export const acquirePdfDocument = async (
	key: string,
	loader: () => Promise<PDFDocumentProxy>
): Promise<{ doc: PDFDocumentProxy; release: () => void }> => {
	let entry = docCache.get(key);
	if (!entry) {
		// De-duplicate concurrent attaches (viewer + thumbnails race on first
		// open) so a 900+ page file is parsed at most once per key.
		let pending = pendingDocs.get(key);
		if (!pending) {
			pending = loader()
				.then((doc) => {
					pendingDocs.delete(key);
					return doc;
				})
				.catch((error) => {
					pendingDocs.delete(key);
					throw error;
				});
			pendingDocs.set(key, pending);
		}
		const doc = await pending;
		entry = { doc, refs: 0, at: Date.now() };
		docCache.set(key, entry);
	}

	entry.refs++;
	entry.at = Date.now();

	const release = () => {
		const current = docCache.get(key);
		if (!current || current !== entry) return;
		current.refs = Math.max(0, current.refs - 1);
		current.at = Date.now();

		if (docCache.size > MAX_CACHED_DOCS) {
			const unused = [...docCache.entries()]
				.filter(([, value]) => value.refs === 0)
				.sort(([, a], [, b]) => a.at - b.at);
			for (const [candidateKey, candidate] of unused) {
				if (docCache.size <= MAX_CACHED_DOCS) break;
				docCache.delete(candidateKey);
				try {
					candidate.doc.destroy();
				} catch {
					// already destroyed
				}
			}
		}
	};

	return { doc: entry.doc, release };
};

// ── Rendered-page cache (module level + IndexedDB) ──────────────────────────
// Rendered page bitmaps are keyed by file + page + zoom + device pixel ratio +
// css scale, so a NEW viewer element for the same document shows a previously
// rendered page instantly without touching the pdf.js worker again. Bitmaps
// are kept in memory (small LRU) and persisted as WebP blobs in IndexedDB
// (store "renders" — visible in Chrome DevTools → Application → IndexedDB).

import {
	IDB_STORE_RENDERS,
	idbDeletePrefix,
	idbGetRecord,
	idbPutRecord
} from '$lib/utils/fileCache';

const bitmapCache = new Map<string, { bitmap: ImageBitmap; at: number }>();
const MAX_CACHED_BITMAPS = 12;

export const renderCacheKey = (
	fileKey: string,
	page: number,
	zoom: number,
	dpr: number,
	cssScale: number
) => `${fileKey}|p${page}|z${Math.round(zoom * 100)}|d${dpr}|c${Math.round(cssScale * 1000)}`;

export const loadCachedRender = async (key: string): Promise<ImageBitmap | null> => {
	const memoryHit = bitmapCache.get(key);
	if (memoryHit) {
		memoryHit.at = Date.now();
		return memoryHit.bitmap;
	}

	const record = await idbGetRecord<{ blob: Blob; at: number }>(IDB_STORE_RENDERS, key);
	if (!record?.blob) return null;

	try {
		const bitmap = await createImageBitmap(record.blob);
		if (bitmapCache.size >= MAX_CACHED_BITMAPS) {
			let oldestKey: string | null = null;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [key_, value] of bitmapCache) {
				if (value.at < oldestAt) {
					oldestAt = value.at;
					oldestKey = key_;
				}
			}
			if (oldestKey) {
				bitmapCache.get(oldestKey)!.bitmap.close();
				bitmapCache.delete(oldestKey);
			}
		}
		bitmapCache.set(key, { bitmap, at: Date.now() });
		return bitmap;
	} catch {
		return null;
	}
};

/** Store a freshly rendered canvas: memory bitmap + persistent WebP blob. */
export const storeCachedRender = async (
	key: string,
	pagePrefix: string,
	canvas: HTMLCanvasElement
): Promise<void> => {
	if (!pagePrefix) return;
	try {
		const bitmap = await createImageBitmap(canvas);
		if (bitmapCache.size >= MAX_CACHED_BITMAPS) {
			let oldestKey: string | null = null;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [key_, value] of bitmapCache) {
				if (value.at < oldestAt) {
					oldestAt = value.at;
					oldestKey = key_;
				}
			}
			if (oldestKey) {
				bitmapCache.get(oldestKey)!.bitmap.close();
				bitmapCache.delete(oldestKey);
			}
		}
		bitmapCache.set(key, { bitmap, at: Date.now() });

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob((result) => resolve(result), 'image/webp', 0.85)
		);
		if (blob) {
			await idbPutRecord(IDB_STORE_RENDERS, key, { blob, at: Date.now() });
			// Keep only the current zoom/width variant per page.
			await idbDeletePrefix(IDB_STORE_RENDERS, pagePrefix, key);
		}
	} catch {
		// ignore — cache is best-effort
	}
};