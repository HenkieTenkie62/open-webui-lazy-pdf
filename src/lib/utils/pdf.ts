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