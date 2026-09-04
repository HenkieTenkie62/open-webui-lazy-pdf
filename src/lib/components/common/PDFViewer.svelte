<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import panzoom, { type PanZoom } from 'panzoom';
	import { clampDocumentTargetPage } from '$lib/utils/documentPreview';
	import {
		loadPdfJs,
		PDF_DOCUMENT_OPTIONS,
		acquirePdfDocument,
		renderCacheKey,
		loadCachedRender,
		storeCachedRender
	} from '$lib/utils/pdf';
	import Spinner from './Spinner.svelte';

	export let url: string | null = null;
	export let data: ArrayBuffer | Uint8Array | null = null;
	export let className = 'w-full h-[70vh]';
	export let targetPage: number | null = null;
	export let singlePage = false;
	export let itemLabel = 'Page';
	export let onPageChange: ((page: number) => void) | null = null;
	/** Stable key for the current file — enables shared doc + render caches. */
	export let cacheKey = '';

	type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;
	type PdfTextLayer = InstanceType<typeof import('pdfjs-dist').TextLayer>;

	let outerContainer: HTMLDivElement;
	let sceneElement: HTMLDivElement;
	let loading = true;
	let error = '';
	let pdfDoc: PdfDocument | null = null;
	let pzInstance: PanZoom | null = null;
	let zoomLevel = 1;
	let rerenderTimer: ReturnType<typeof setTimeout> | null = null;
	let lastRenderedZoom = 1;
	let pageCount = 0;
	let renderedPage = 0;
	let activePage = 1;
	let loadToken = 0;
	let renderToken = 0;
	let scrollFrame: number | null = null;
	let mounted = false;
	let loadedSource: ArrayBuffer | Uint8Array | string | null = null;
	let wheelDelta = 0;
	let lastWheelNavigationAt = 0;
	const wheelNavigationThreshold = 80;
	const wheelNavigationCooldown = 450;
	const pageShortcutKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

	$: selectedPage = singlePage ? (clampDocumentTargetPage(targetPage, pageCount) ?? 1) : activePage;

	// Keep a reference to TextLayer instances (by page number) so we can update/cancel them
	let textLayerByPage: Map<number, PdfTextLayer> = new Map();

	// Lazy (virtualized) rendering state for continuous mode: page placeholders are
	// created immediately while canvas + text layer rendering is deferred to pages
	// near the viewport, and freed again once they scroll far out of view. This
	// makes opening and page-jumping instant even for documents with 900+ pages.
	let pageObserver: IntersectionObserver | null = null;
	let farPageObserver: IntersectionObserver | null = null;
	let renderedPages: Set<number> = new Set();
	let wantedPages: Set<number> = new Set();
	let pagesInRenderRange: Set<number> = new Set();
	let pageRenderZoom: Map<number, number> = new Map();
	let renderQueue: number[] = [];
	let renderQueueRunning = false;
	let releaseDoc: (() => void) | null = null;
	// Tracks the in-flight pdf.js render/text-layer task so switching documents can
	// actively cancel them and free the shared pdf.js worker for the new file.
	let activeRenderTask: { cancel: () => void } | null = null;
	let activeTextLayerTask: { cancel: () => void } | null = null;
	let renderCancelRequested = false;
	// Idle-time bitmap encodes still pending for this viewer session.
	let pendingEncodes = new Set<string>();
	let loadedCacheKey = '';
	// Strict priority: while set, only this page is rendered — everything else
	// stays queued until the requested/visible page has been served.
	let priorityPage: number | null = null;
	// LRU of rendered pages (oldest first): recently rendered pages stay alive
	// so scrolling back is instant; overflow frees the least recent ones.
	let renderCacheOrder: number[] = [];
	const maxRenderCachePages =
		typeof window !== 'undefined' && (window.devicePixelRatio || 1) >= 2 ? 8 : 14;

	const copyPdfData = (pdfData: ArrayBuffer | Uint8Array) =>
		pdfData instanceof Uint8Array ? pdfData.slice() : pdfData.slice(0);

	// Let the browser paint/interact between heavy render steps so the whole UI
	// does not freeze while pages are being rasterized or text layers built.
	const yieldFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

	// Actively cancel the current page render (canvas + text layer) so a newly
	// opened display_file gets the full worker instead of waiting behind old jobs.
	const cancelActiveRender = () => {
		renderCancelRequested = true;
		if (activeRenderTask) {
			try {
				activeRenderTask.cancel();
			} catch {
				// already finished/failed
			}
			activeRenderTask = null;
		}
		if (activeTextLayerTask) {
			try {
				activeTextLayerTask.cancel();
			} catch {
				// noop
			}
			activeTextLayerTask = null;
		}
	};

	// Keep the math-based scroll tracking (cumulative page offsets) in sync.
	let pageCssHeights: number[] = [];
	let pageCssOffsets: number[] = [];
	let offsetsDirty = false;

	const setPageCssHeight = (pageNumber: number, cssHeight: number) => {
		pageCssHeights[pageNumber - 1] = cssHeight;
		offsetsDirty = true;
	};

	const recomputeOffsets = () => {
		let y = 0;
		for (let i = 0; i < pageCssHeights.length; i++) {
			pageCssOffsets[i] = y;
			y += pageCssHeights[i] + (i > 0 ? 4 : 0);
		}
		offsetsDirty = false;
	};

	const cancelTextLayers = () => {
		for (const tl of textLayerByPage.values()) {
			try {
				tl.cancel();
			} catch {
				// Text layers can already be resolved or canceled during rerenders.
			}
		}
		textLayerByPage = new Map();
	};

	const initPanzoom = () => {
		if (pzInstance) {
			pzInstance.dispose();
		}
		if (sceneElement) {
			pzInstance = panzoom(sceneElement, {
				bounds: true,
				boundsPadding: 0.1,
				zoomSpeed: 0.065,
				beforeWheel: (e) => {
					// Only zoom on pinch (ctrlKey / metaKey); let normal scroll pass through
					if (!e.ctrlKey && !e.metaKey) {
						return true; // returning true cancels the panzoom wheel handling
					}
					return false;
				},
				beforeMouseDown: (e) => {
					// Only allow drag-to-pan when zoomed in (not at default scale)
					if ((e?.target as HTMLElement | null)?.closest?.('.textLayer')) {
						return true;
					}
					const transform = pzInstance?.getTransform();
					if (transform && Math.abs(transform.scale - 1) < 0.01) {
						return true; // cancel panzoom mouse handling at 1x — allow text selection / normal interaction
					}
					return false;
				}
			});
			pzInstance.on('zoom', () => {
				zoomLevel = pzInstance?.getTransform()?.scale ?? 1;
				// Debounced re-render at new resolution so text stays crisp
				if (rerenderTimer) clearTimeout(rerenderTimer);
				rerenderTimer = setTimeout(() => {
					if (Math.abs(zoomLevel - lastRenderedZoom) > 0.05) {
						rerenderPages(zoomLevel);
					}
				}, 300);
			});
		}
	};

	const zoomIn = () => {
		if (!pzInstance || !outerContainer) return;
		const cx = outerContainer.clientWidth / 2;
		const cy = outerContainer.clientHeight / 2;
		pzInstance.zoomTo(cx, cy, 1.25); // +25%
		zoomLevel = pzInstance.getTransform().scale;
	};

	const zoomOut = () => {
		if (!pzInstance || !outerContainer) return;
		const cx = outerContainer.clientWidth / 2;
		const cy = outerContainer.clientHeight / 2;
		pzInstance.zoomTo(cx, cy, 0.8); // -20% (inverse of 1.25)
		zoomLevel = pzInstance.getTransform().scale;
	};

	export const resetView = () => {
		if (pzInstance) {
			pzInstance.moveTo(0, 0);
			pzInstance.zoomAbs(0, 0, 1);
			zoomLevel = 1;
			rerenderPages(1);
		}
	};

	export const scrollToPage = async (page: number | null) => {
		targetPage = page;
		if (singlePage) {
			if (targetPage) onPageChange?.(targetPage);
		} else {
			await scrollToTargetPage();
		}
	};

	const selectPage = async (page: number) => {
		if (!pdfDoc) return;
		const nextPage = clampDocumentTargetPage(page, pdfDoc.numPages);
		if (!nextPage || nextPage === selectedPage) return;

		targetPage = nextPage;
		activePage = nextPage;
		onPageChange?.(nextPage);
		if (!singlePage) await scrollToTargetPage();
	};

	const scrollToTargetPage = async () => {
		if (!outerContainer || !sceneElement || !pdfDoc) return;
		const page = clampDocumentTargetPage(targetPage, pdfDoc.numPages);
		if (!page) return;

		if (singlePage) return;

		await tick();
		const pageWrapper = sceneElement.querySelectorAll('.pdf-page-wrapper')[page - 1] as
			| HTMLElement
			| undefined;
		pageWrapper?.scrollIntoView({ block: 'start' });
		activePage = page;
		onPageChange?.(page);
		// The requested page renders with strict priority and shows first;
		// the ±2 neighbors warm up only after it has been served.
		setPriorityPage(page);
	};

	const syncVisiblePage = () => {
		scrollFrame = null;
		if (singlePage || !outerContainer || !sceneElement || !pdfDoc) return;

		const transform = pzInstance?.getTransform();
		const atDefaultScale =
			transform &&
			Math.abs(transform.scale - 1) < 0.01 &&
			Math.abs(transform.x) < 0.5 &&
			Math.abs(transform.y) < 0.5;

		let bestPage: number;
		if (atDefaultScale && pageCssOffsets.length === pdfDoc.numPages) {
			// Math path: binary search the cumulative offsets — no DOM reads, so
			// scrolling a 900+ page document does not jank on ~querySelectorAll.
			if (offsetsDirty) recomputeOffsets();
			const markerY = outerContainer.scrollTop + outerContainer.clientHeight * 0.35;
			let lo = 0;
			let hi = pdfDoc.numPages - 1;
			let ans = 0;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (pageCssOffsets[mid] <= markerY) {
					ans = mid;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			bestPage = ans + 1;
		} else {
			// Fallback (zoomed/panned): measure the actual wrapper positions.
			const marker =
				outerContainer.getBoundingClientRect().top + outerContainer.clientHeight * 0.35;
			let bestPage_ = activePage;
			let bestDistance = Number.POSITIVE_INFINITY;

			for (const wrapper of sceneElement.querySelectorAll('.pdf-page-wrapper')) {
				const el = wrapper as HTMLElement;
				const page = Number(el.dataset.pageNumber);
				if (!page) continue;

				const rect = el.getBoundingClientRect();
				const distance =
					marker < rect.top ? rect.top - marker : marker > rect.bottom ? marker - rect.bottom : 0;
				if (distance < bestDistance) {
					bestDistance = distance;
					bestPage_ = page;
				}
			}
			bestPage = bestPage_;
		}

		if (bestPage !== activePage) {
			activePage = bestPage;
			onPageChange?.(bestPage);
			// The page closest to the scroll position gets rendering priority,
			// followed by its ±2 neighbors.
			setPriorityPage(bestPage);
		}
	};

	const handleScroll = () => {
		if (singlePage || scrollFrame !== null) return;
		scrollFrame = requestAnimationFrame(syncVisiblePage);
	};

	// Zoom changed: re-render canvases at a higher internal resolution so text
	// stays crisp. With lazy rendering we only refresh pages that are currently
	// in/near the viewport; off-screen pages are marked stale and re-rendered
	// when they scroll back into view.
	const rerenderPages = async (forZoom: number) => {
		if (!pdfDoc || !sceneElement) return;
		lastRenderedZoom = forZoom;

		if (singlePage) {
			await renderPageInto(clampDocumentTargetPage(selectedPage, pdfDoc.numPages) ?? selectedPage);
			return;
		}

		for (const page of Array.from(pageRenderZoom.keys())) {
			if (pageRenderZoom.get(page) === forZoom) continue;
			pageRenderZoom.delete(page);
			enqueuePageRender(page, wantedPages.has(page));
		}
	};

	const getCssScale = (viewport: { width: number; height: number }) => {
		if (!singlePage) return (outerContainer?.clientWidth || 800) / viewport.width;

		const availableWidth = Math.max(320, (outerContainer?.clientWidth || 800) - 64);
		const availableHeight = Math.max(220, (outerContainer?.clientHeight || 600) - 64);
		return Math.min(1, availableWidth / viewport.width, availableHeight / viewport.height);
	};

	// Single page mode: only the selected page lives in the scene, so we render
	// it directly — no virtualization needed there.
	const renderAllPages = async () => {
		if (!pdfDoc || !sceneElement) return;
		const token = ++renderToken;

		// Clear previous content
		sceneElement.innerHTML = '';

		cancelTextLayers();
		pageObserver?.disconnect();
		farPageObserver?.disconnect();
		renderedPages = new Set();
		wantedPages = new Set();
		pagesInRenderRange = new Set();
		pageRenderZoom = new Map();
		renderQueue = [];
		priorityPage = null;
		renderCacheOrder = [];

		const pageNumber = clampDocumentTargetPage(targetPage, pdfDoc.numPages) ?? 1;
		const page = await pdfDoc.getPage(pageNumber);
		if (token !== renderToken) return;
		const viewport = page.getViewport({ scale: 1 });

		// Scale to fit the container while keeping the whole page visible
		const cssScale = getCssScale(viewport);

		const wrapper = document.createElement('div');
		wrapper.className = 'pdf-page-wrapper';
		wrapper.dataset.pageNumber = String(pageNumber);
		wrapper.style.position = 'relative';
		wrapper.style.width = `${Math.round(cssScale * viewport.width)}px`;
		wrapper.style.height = `${Math.round(cssScale * viewport.height)}px`;
		wrapper.style.display = 'block';
		wrapper.style.setProperty('--scale-factor', String(cssScale));

		sceneElement.replaceChildren(wrapper);
		renderedPage = pageNumber;
		initPanzoom();

		await renderPageInto(pageNumber);
	};

	// Continuous mode: build lightweight placeholders for every page up front so
	// document height, scrollbar and page jumps are instant. Canvas + text layer
	// rendering is deferred to pages near the viewport (see watchPages), which
	// makes opening large documents (900+ pages) take milliseconds instead of
	// minutes.
	const buildPagesStructure = async () => {
		if (!pdfDoc || !sceneElement) return;
		const token = ++renderToken;

		// Clear previous content
		sceneElement.innerHTML = '';

		cancelTextLayers();
		pageObserver?.disconnect();
		farPageObserver?.disconnect();
		renderedPages = new Set();
		wantedPages = new Set();
		pagesInRenderRange = new Set();
		pageRenderZoom = new Map();
		renderQueue = [];
		priorityPage = null;
		renderCacheOrder = [];

		// The requested page is fetched first and its size seeds the placeholders
		// for every other page, so the document appears immediately without
		// waiting for all page dimensions. Real dimensions are refined in the
		// background by refinePageDimensions() without blocking rendering.
		const numPages = pdfDoc.numPages;
		const requestedPage = clampDocumentTargetPage(targetPage, numPages) ?? 1;
		const requestedPdfPage = await pdfDoc.getPage(requestedPage);
		if (token !== renderToken) return;
		const requestedViewport = requestedPdfPage.getViewport({ scale: 1 });
		const fallbackWidth = requestedViewport.width;
		const fallbackHeight = requestedViewport.height;

		const wrappers: HTMLElement[] = [];
		for (let i = 1; i <= numPages; i++) {
			// Scale to fit container width
			const cssScale = getCssScale({ width: fallbackWidth, height: fallbackHeight });

			// Create page wrapper placeholder (positioned container for canvas + text layer)
			const wrapper = document.createElement('div');
			wrapper.className = 'pdf-page-wrapper';
			wrapper.dataset.pageNumber = String(i);
			wrapper.style.position = 'relative';
			wrapper.style.width = `${Math.round(cssScale * fallbackWidth)}px`;
			wrapper.style.height = `${Math.round(cssScale * fallbackHeight)}px`;
			wrapper.style.display = 'block';
			// pdfjs TextLayer uses --total-scale-factor (= --scale-factor * --user-unit)
			// to position/size text spans. We must set --scale-factor so the calc resolves.
			wrapper.style.setProperty('--scale-factor', String(cssScale));

			if (i > 1) {
				wrapper.style.marginTop = '4px';
			}
			wrappers.push(wrapper);
		}

		// Seed the math-based scroll path with the placeholder sizes (refined
		// progressively in refinePageDimensions + renderPageInto).
		pageCssHeights = wrappers.map((w) => parseFloat(w.style.height) || 0);
		pageCssOffsets = new Array(numPages);
		recomputeOffsets();

		sceneElement.replaceChildren(...wrappers);
		lastRenderedZoom = 1;
		renderedPage = 0;
		initPanzoom();

		watchPages();

		// The requested page renders first (strict priority); only after it has
		// been served does the queue continue with the ±2 neighbors etc.
		await scrollToTargetPage();
		if (token === renderToken) syncVisiblePage();

		// Correct the placeholder sizes to the real page dimensions in the
		// background — this never blocks rendering.
		if (token === renderToken) void refinePageDimensions(token);
	};

	// Progressively fetch real page dimensions and correct the placeholder
	// sizes (initially derived from the requested page).
	const refinePageDimensions = async (token: number) => {
		if (!pdfDoc) return;
		const doc = pdfDoc;
		const numPages = doc.numPages;
		let next = 1;

		const applyDims = (pageNumber: number, width: number, height: number) => {
			if (!sceneElement || renderedPages.has(pageNumber)) return;
			const wrapper = sceneElement.querySelector(
				`.pdf-page-wrapper[data-page-number="${pageNumber}"]`
			) as HTMLElement | null;
			if (!wrapper) return;

			const cssScale = getCssScale({ width, height });
			const widthPx = Math.round(cssScale * width);
			const heightPx = Math.round(cssScale * height);
			if (wrapper.style.width !== `${widthPx}px`) wrapper.style.width = `${widthPx}px`;
			if (wrapper.style.height !== `${heightPx}px`) {
				wrapper.style.height = `${heightPx}px`;
				pageCssHeights[pageNumber - 1] = heightPx;
				offsetsDirty = true;
			}
			wrapper.style.setProperty('--scale-factor', String(cssScale));
		};

		await Promise.all(
			Array.from({ length: Math.min(4, numPages) }, async () => {
				while (next <= numPages) {
					if (token !== renderToken) return;
					const pageNumber = next++;
					// Pages that are (about to be) rendered set their own size.
					if (wantedPages.has(pageNumber)) continue;
					try {
						const page = await doc.getPage(pageNumber);
						if (token !== renderToken) return;
						const viewport = page.getViewport({ scale: 1 });
						applyDims(pageNumber, viewport.width, viewport.height);
					} catch {
						// Keep the derived placeholder size for this page.
					}
				}
			})
		);
	};

	// Persist a rendered page to the shared render cache, but only when the
	// browser is idle — WebP-encoding a full-width page on the main thread
	// right after it becomes visible would freeze the UI.
	const deferStoreRender = (renderKey: string, pageNumber: number, canvas: HTMLCanvasElement) => {
		const pagePrefix = `${cacheKey}|p${pageNumber}`;
		// Limit how many encodes can be pending at once and never let encodes from
		// a document the user has moved away from block the main thread.
		if (pendingEncodes.size >= 4) return;
		const fileKey = cacheKey;
		pendingEncodes.add(renderKey);
		const run = () => {
			pendingEncodes.delete(renderKey);
			// The viewer now shows a DIFFERENT file: drop the stale encode.
			if (!cacheKey || fileKey !== cacheKey) return;
			void storeCachedRender(renderKey, pagePrefix, canvas);
		};
		if (
			typeof (window as Window & { requestIdleCallback?: unknown }).requestIdleCallback ===
			'function'
		) {
			(window as Window & {
				requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
			}).requestIdleCallback(run, { timeout: 5000 });
		} else {
			setTimeout(run, 1500);
		}
	};

	// Render canvas + text layer for one page into its placeholder wrapper.
	const renderPageInto = async (pageNumber: number) => {
		if (!pdfDoc || !sceneElement) return;
		const token = renderToken;

		const wrapper = sceneElement.querySelector(
			`.pdf-page-wrapper[data-page-number="${pageNumber}"]`
		) as HTMLElement | null;
		if (!wrapper) return;

		const pdfjs = await loadPdfJs();
		if (token !== renderToken) return;
		const dpr = window.devicePixelRatio || 1;

		const page = await pdfDoc.getPage(pageNumber);
		if (token !== renderToken) return;
		const viewport = page.getViewport({ scale: 1 });

		// Scale to fit container width
		const cssScale = getCssScale(viewport);
		const renderScale = cssScale * lastRenderedZoom * dpr;
		const scaledViewport = page.getViewport({ scale: renderScale });
		const cssViewport = page.getViewport({ scale: cssScale });

		// Drop any previous content for this page (stale zoom or leftover render)
		const existingTextLayer = textLayerByPage.get(pageNumber);
		if (existingTextLayer) {
			try {
				existingTextLayer.cancel();
			} catch {
				// noop
			}
			textLayerByPage.delete(pageNumber);
		}
		wrapper.querySelector('canvas')?.remove();
		wrapper.querySelector('.textLayer')?.remove();
		// Correct the wrapper size to the real page dimensions (placeholders may
		// still be derived from the requested page).
		wrapper.style.width = `${Math.round(cssScale * viewport.width)}px`;
		wrapper.style.height = `${Math.round(cssScale * viewport.height)}px`;
		pageCssHeights[pageNumber - 1] = cssScale * viewport.height;
		offsetsDirty = true;
		wrapper.style.setProperty('--scale-factor', String(cssViewport.scale));

		// Create canvas
		const canvas = document.createElement('canvas');
		canvas.width = scaledViewport.width;
		canvas.height = scaledViewport.height;
		// CSS size stays at the CSS-pixel dimensions for layout
		canvas.style.width = `${Math.round(cssScale * viewport.width)}px`;
		canvas.style.height = `${Math.round(cssScale * viewport.height)}px`;
		canvas.style.display = 'block';
		wrapper.appendChild(canvas);

		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		await yieldFrame();
		if (token !== renderToken) return;

		// Reuse a previously rasterized page (shared render cache + IndexedDB)
		// when available, so a NEW viewer element for the same file shows the
		// page instantly instead of re-rendering from the pdf.js worker.
		const renderKey = cacheKey
			? renderCacheKey(cacheKey, pageNumber, lastRenderedZoom, dpr, cssScale)
			: '';
		const cachedBitmap = renderKey ? await loadCachedRender(renderKey) : null;
		if (token !== renderToken) return;

		if (cachedBitmap) {
			canvas.width = scaledViewport.width;
			canvas.height = scaledViewport.height;
			await yieldFrame();
			if (token !== renderToken) return;
			ctx.drawImage(cachedBitmap, 0, 0, canvas.width, canvas.height);
			await yieldFrame();
			if (token !== renderToken) return;
		} else {
			await yieldFrame();
			if (token !== renderToken) return;
			const task = page.render({
				canvas,
				canvasContext: ctx,
				viewport: scaledViewport
			});
			activeRenderTask = task;
			try {
				await task.promise;
			} catch (error) {
				if (renderCancelRequested) {
					// Canceled because a new document was opened — swallow silently.
					renderCancelRequested = false;
					return;
				}
				throw error;
			} finally {
				if (activeRenderTask === task) activeRenderTask = null;
			}
			if (token !== renderToken) return;
			await yieldFrame();
			if (token !== renderToken) return;
			if (renderKey) {
				// Persist the raster outside the render path so the encode never
				// blocks the UI right after a page becomes visible.
				deferStoreRender(renderKey, pageNumber, canvas);
			}
		}
		if (token !== renderToken) return;

		// Create text layer overlay — pdfjs setLayerDimensions handles its sizing
		const textLayerDiv = document.createElement('div');
		textLayerDiv.className = 'textLayer';
		wrapper.appendChild(textLayerDiv);

		const textContent = await page.getTextContent();
		const textLayer = new pdfjs.TextLayer({
			textContentSource: textContent,
			container: textLayerDiv,
			viewport: cssViewport
		});
		activeTextLayerTask = textLayer;
		try {
			await textLayer.render();
		} catch (error) {
			if (renderCancelRequested) {
				renderCancelRequested = false;
				return;
			}
			throw error;
		} finally {
			if (activeTextLayerTask === textLayer) activeTextLayerTask = null;
		}
		if (token !== renderToken) return;
		textLayerByPage.set(pageNumber, textLayer);

		renderedPages.add(pageNumber);
		pageRenderZoom.set(pageNumber, lastRenderedZoom);
		if (priorityPage === pageNumber) priorityPage = null;

		// Keep the page in the render cache so scrolling back is instant; LRU
		// eviction frees it once it falls out of the cache.
		touchRenderCache(pageNumber);
		evictRenderCache();
	};

	// Remove canvas + text layer from a page wrapper, keeping the placeholder
	// size intact. Keeps memory bounded while scrolling through large documents.
	const unrenderPage = (pageNumber: number) => {
		if (!sceneElement) return;
		const wrapper = sceneElement.querySelector(
			`.pdf-page-wrapper[data-page-number="${pageNumber}"]`
		);
		if (!wrapper) return;

		const textLayer = textLayerByPage.get(pageNumber);
		if (textLayer) {
			try {
				textLayer.cancel();
			} catch {
				// noop
			}
			textLayerByPage.delete(pageNumber);
		}
		wrapper.querySelector('canvas')?.remove();
		wrapper.querySelector('.textLayer')?.remove();
		renderedPages.delete(pageNumber);
		pageRenderZoom.delete(pageNumber);
	};

	const runRenderQueue = async () => {
		if (renderQueueRunning) return;
		renderQueueRunning = true;
		try {
			while (renderQueue.length > 0) {
				const pageNumber = renderQueue.shift()!;
				if (!pdfDoc || !sceneElement) return;

				// Abort promptly while another (newer) document is being loaded.
				if (renderCancelRequested) {
					renderCancelRequested = false;
					return;
				}

				// Strict priority: nothing else renders until the requested/visible
				// page has been served.
				if (priorityPage !== null && pageNumber !== priorityPage) {
					renderQueue.push(pageNumber);
					break;
				}

				// Already rendered at the current zoom? Nothing to do.
				if (
					renderedPages.has(pageNumber) &&
					pageRenderZoom.get(pageNumber) === lastRenderedZoom
				) {
					continue;
				}

				try {
					await renderPageInto(pageNumber);
				} catch (e) {
					if (renderCancelRequested) {
						renderCancelRequested = false;
						return;
					}
					// console.warn is NOT stripped in production builds (only
					// console.log/debug/error are via esbuild.pure) — render
					// failures stay visible in the console.
					console.warn('PDF page render error:', e);
					if (priorityPage === pageNumber) priorityPage = null;
				}

				// Let the UI paint/respond between pages.
				await yieldFrame();
				if (!pdfDoc || !sceneElement) return;
			}
		} finally {
			renderQueueRunning = false;
		}
	};

	const enqueuePageRender = (pageNumber: number, priority = false) => {
		if (singlePage) return;
		if (
			!priority &&
			renderedPages.has(pageNumber) &&
			pageRenderZoom.get(pageNumber) === lastRenderedZoom
		) {
			return;
		}

		const index = renderQueue.indexOf(pageNumber);
		if (index !== -1) renderQueue.splice(index, 1);
		if (priority) {
			renderQueue.unshift(pageNumber);
		} else {
			renderQueue.push(pageNumber);
		}
		void runRenderQueue();
	};

	// Strict priority for the requested/visible page: render it first, then
	// warm the two pages before and after it. While the priority page has not
	// been served, the render queue does not touch anything else.
	const setPriorityPage = (pageNumber: number) => {
		if (singlePage || !pdfDoc) return;
		const clamped = clampDocumentTargetPage(pageNumber, pdfDoc.numPages);
		if (!clamped) return;

		if (renderedPages.has(clamped) && pageRenderZoom.get(clamped) === lastRenderedZoom) {
			priorityPage = null;
		} else {
			priorityPage = clamped;
			enqueuePageRender(clamped, true);
		}

		for (const neighbor of [clamped - 2, clamped - 1, clamped + 1, clamped + 2]) {
			if (neighbor >= 1 && neighbor <= pdfDoc.numPages) {
				enqueuePageRender(neighbor);
			}
		}
	};

	// Render cache (LRU, oldest first): recently rendered pages stay alive so
	// scrolling back is instant. Overflow frees the oldest page that is not
	// currently needed.
	const touchRenderCache = (pageNumber: number) => {
		const index = renderCacheOrder.indexOf(pageNumber);
		if (index !== -1) renderCacheOrder.splice(index, 1);
		renderCacheOrder.push(pageNumber);
	};

	const evictRenderCache = () => {
		if (renderCacheOrder.length <= maxRenderCachePages) return;

		for (
			let i = 0;
			i < renderCacheOrder.length && renderCacheOrder.length > maxRenderCachePages;
			i++
		) {
			const candidate = renderCacheOrder[i];
			if (
				wantedPages.has(candidate) ||
				pagesInRenderRange.has(candidate) ||
				candidate === priorityPage
			) {
				continue;
			}
			renderCacheOrder.splice(i, 1);
			i--;
			unrenderPage(candidate);
		}
	};

	// Observe page placeholders: pages near the viewport get rendered, pages that
	// scrolled out of the wider range have their canvas/text layer freed again.
	const watchPages = () => {
		if (!outerContainer || !sceneElement) return;
		pageObserver?.disconnect();
		farPageObserver?.disconnect();

		pageObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
					if (!pageNumber) continue;

					if (entry.isIntersecting) {
						wantedPages.add(pageNumber);
						touchRenderCache(pageNumber);
						enqueuePageRender(pageNumber);
					} else {
						// Stay rendered (render cache) until LRU eviction frees it.
						wantedPages.delete(pageNumber);
					}
				}
			},
			{ root: outerContainer, rootMargin: '100% 0px 100% 0px' }
		);

		farPageObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
					if (!pageNumber) continue;

					if (entry.isIntersecting) {
						pagesInRenderRange.add(pageNumber);
					} else {
						// Leave the page to the render cache; LRU eviction frees it.
						pagesInRenderRange.delete(pageNumber);
					}
				}
			},
			{ root: outerContainer, rootMargin: '300% 0px 300% 0px' }
		);

		for (const wrapper of sceneElement.querySelectorAll('.pdf-page-wrapper')) {
			pageObserver.observe(wrapper);
			farPageObserver.observe(wrapper);
		}
	};

	const handleWheel = (e: WheelEvent) => {
		if (!singlePage) return;
		if (e.ctrlKey || e.metaKey) return;

		const transform = pzInstance?.getTransform();
		if (transform && Math.abs(transform.scale - 1) >= 0.01) {
			e.preventDefault();
			pzInstance?.moveBy(-e.deltaX, -e.deltaY, false);
			zoomLevel = pzInstance?.getTransform()?.scale ?? 1;
			return;
		}

		e.preventDefault();
		if (pageCount <= 1) return;

		const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? outerContainer.clientHeight : 1;
		const dominantDelta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
		wheelDelta += dominantDelta * multiplier;

		const now = Date.now();
		if (Math.abs(wheelDelta) < wheelNavigationThreshold) return;
		if (now - lastWheelNavigationAt < wheelNavigationCooldown) {
			wheelDelta = 0;
			return;
		}

		lastWheelNavigationAt = now;
		void selectPage(selectedPage + (wheelDelta > 0 ? 1 : -1));
		wheelDelta = 0;
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (
			!singlePage ||
			e.defaultPrevented ||
			e.altKey ||
			e.ctrlKey ||
			e.metaKey ||
			pageCount <= 1 ||
			!pageShortcutKeys.includes(e.key)
		) {
			return;
		}

		e.preventDefault();
		void selectPage(selectedPage + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1));
	};

	const focusViewer = () => {
		if (!outerContainer?.contains(document.activeElement)) outerContainer?.focus();
	};

	const loadPdf = async () => {
		if (!url && !data) return;

		const source = data ?? url;
		// Same file requested again — the document + page bitmaps are already
		// loaded and shared, so a new display_file for the same path is instant.
		if (cacheKey && pdfDoc && loadedCacheKey === cacheKey) return;
		if (source === loadedSource && pdfDoc) return;
		const token = ++loadToken;
		loadedSource = source;
		loading = true;
		error = '';
		renderedPage = 0;
		pageCount = 0;
		pzInstance?.dispose();
		cancelTextLayers();
		pageObserver?.disconnect();
		farPageObserver?.disconnect();
		renderQueue = [];
		// Cancel the in-flight page render from the previous file so the shared
		// pdf.js worker is free for the new document immediately.
		cancelActiveRender();
		renderToken++;
		renderCancelRequested = false;
		pendingEncodes.clear();
		loadedCacheKey = cacheKey;
		if (releaseDoc) {
			releaseDoc();
			releaseDoc = null;
		} else {
			pdfDoc?.destroy();
		}
		pdfDoc = null;

		try {
			const pdfjs = await loadPdfJs();

			let pdfData: ArrayBuffer | Uint8Array;
			if (data) {
				pdfData = copyPdfData(data);
			} else {
				// Fetch with credentials so auth cookies are sent
				const res = await fetch(url!, { credentials: 'include' });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				pdfData = await res.arrayBuffer();
			}
			if (cacheKey) {
				// Reuse the shared parsed document across viewer elements so the
				// expensive parse of a 900+ page file happens at most once.
				const { doc, release } = await acquirePdfDocument(
					`doc:${cacheKey}`,
					() => pdfjs.getDocument({ data: pdfData, ...PDF_DOCUMENT_OPTIONS }).promise
				);
				if (token !== loadToken) {
					release();
					return;
				}
				pdfDoc = doc;
				releaseDoc = release;
			} else {
				pdfDoc = await pdfjs.getDocument({ data: pdfData, ...PDF_DOCUMENT_OPTIONS }).promise;
			}
			if (token !== loadToken) return;
			pageCount = pdfDoc.numPages;
			activePage = clampDocumentTargetPage(targetPage, pageCount) ?? 1;
			targetPage = clampDocumentTargetPage(targetPage, pageCount) ?? 1;
			if (singlePage) {
				await renderAllPages();
			} else {
				await buildPagesStructure();
			}
		} catch (e) {
			if (token === loadToken) {
				console.warn('PDF render error:', e);
				error = 'Failed to load PDF.';
			}
		} finally {
			if (token === loadToken) loading = false;
		}
	};

	onMount(() => {
		mounted = true;
		loadPdf();
	});

	$: if (mounted && (data || url)) {
		void loadPdf();
	}

	$: if (!loading && pdfDoc && singlePage && targetPage && selectedPage !== renderedPage) {
		void renderAllPages();
	}

	$: if (!loading && pdfDoc && !singlePage && targetPage) {
		void scrollToTargetPage();
	}

	onDestroy(() => {
		loadToken++;
		renderToken++;
		if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
		if (rerenderTimer) clearTimeout(rerenderTimer);
		pzInstance?.dispose();
		cancelTextLayers();
		pageObserver?.disconnect();
		farPageObserver?.disconnect();
		renderQueue = [];
		cancelActiveRender();
		renderCancelRequested = false;
		pendingEncodes.clear();
		if (releaseDoc) {
			releaseDoc();
			releaseDoc = null;
		} else {
			pdfDoc?.destroy();
		}
		pdfDoc = null;
	});
</script>

<div class="relative {className}">
	{#if loading}
		<div class="absolute inset-0 flex items-center justify-center">
			<Spinner className="size-5" />
		</div>
	{:else if error}
		<div class="absolute inset-0 flex items-center justify-center text-sm text-red-500">
			{error}
		</div>
	{/if}

	<div
		class={singlePage
			? 'overflow-hidden h-full flex items-center justify-center overscroll-contain'
			: 'overflow-y-auto h-full'}
		bind:this={outerContainer}
		role="application"
		aria-label={`${itemLabel} viewer`}
		tabindex="0"
		on:scroll={handleScroll}
		on:wheel|nonpassive={handleWheel}
		on:pointerdown={focusViewer}
		on:keydown={handleKeyDown}
	>
		<div bind:this={sceneElement} class={singlePage ? '' : 'w-full'}></div>
	</div>

	{#if !error && pdfDoc}
		<div
			class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 rounded-lg bg-white/90 dark:bg-gray-850/90 backdrop-blur-sm shadow-lg border border-gray-200/60 dark:border-gray-700/60 px-1 py-0.5"
		>
			{#if singlePage}
				<button
					type="button"
					class="shrink-0 min-w-7 h-7 inline-flex items-center justify-center p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition text-gray-500 dark:text-gray-400 disabled:opacity-30"
					disabled={selectedPage === 1}
					on:click={() => selectPage(selectedPage - 1)}
					aria-label={`Previous ${itemLabel.toLowerCase()}`}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						class="size-3.5"
					>
						<path
							fill-rule="evenodd"
							d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>
				<span
					class="shrink-0 min-w-12 text-center text-[0.6875rem] text-gray-500 dark:text-gray-400 tabular-nums"
					>{selectedPage} / {pageCount}</span
				>
				<button
					type="button"
					class="shrink-0 min-w-7 h-7 inline-flex items-center justify-center p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition text-gray-500 dark:text-gray-400 disabled:opacity-30"
					disabled={selectedPage === pageCount}
					on:click={() => selectPage(selectedPage + 1)}
					aria-label={`Next ${itemLabel.toLowerCase()}`}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						class="size-3.5"
					>
						<path
							fill-rule="evenodd"
							d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>
			{/if}
			<!-- Pinch covers in/out on coarse pointers; reset has no gesture, so it stays -->
			<button
				type="button"
				class="shrink-0 min-w-7 h-7 inline-flex items-center justify-center p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition text-gray-500 dark:text-gray-400 pointer-coarse:hidden"
				on:click={zoomOut}
				aria-label="Zoom out"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 20 20"
					fill="currentColor"
					class="size-3.5"
				>
					<path
						fill-rule="evenodd"
						d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z"
						clip-rule="evenodd"
					/>
				</svg>
			</button>
			<button
				type="button"
				class="shrink-0 min-w-12 h-7 px-1.5 py-1 text-center text-[0.6875rem] font-normal text-gray-500 dark:text-gray-400 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition tabular-nums"
				on:click={resetView}
				aria-label="Reset zoom"
			>
				{Math.round(zoomLevel * 100)}%
			</button>
			<button
				type="button"
				class="shrink-0 min-w-7 h-7 inline-flex items-center justify-center p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition text-gray-500 dark:text-gray-400 pointer-coarse:hidden"
				on:click={zoomIn}
				aria-label="Zoom in"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 20 20"
					fill="currentColor"
					class="size-3.5"
				>
					<path
						d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"
					/>
				</svg>
			</button>
		</div>
	{/if}
</div>

<style>
	/*
	 * Minimal textLayer styles extracted from pdfjs-dist/web/pdf_viewer.css.
	 * These ensure the invisible text spans are positioned exactly over the
	 * rendered canvas so that browser-native Ctrl+F search and text selection
	 * work correctly.
	 */
	:global(.textLayer) {
		position: absolute;
		text-align: initial;
		inset: 0;
		overflow: clip;
		opacity: 1;
		line-height: 1;
		-webkit-text-size-adjust: none;
		-moz-text-size-adjust: none;
		text-size-adjust: none;
		forced-color-adjust: none;
		transform-origin: 0 0;
		caret-color: CanvasText;
		z-index: 0;
	}

	:global(.textLayer :is(span, br)) {
		color: transparent;
		position: absolute;
		white-space: pre;
		cursor: text;
		transform-origin: 0% 0%;
	}

	:global(.textLayer) {
		/* --total-scale-factor is derived from --scale-factor (set on the wrapper)
		   and --user-unit (defaults to 1). This mirrors the official pdf_viewer.css. */
		--user-unit: 1;
		--total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
		--min-font-size: 1;
		--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
		--min-font-size-inv: calc(1 / var(--min-font-size));
	}

	:global(.textLayer > :not(.markedContent)),
	:global(.textLayer .markedContent span:not(.markedContent)) {
		z-index: 1;
		--font-height: 0;
		font-size: calc(var(--text-scale-factor) * var(--font-height));
		--scale-x: 1;
		--rotate: 0deg;
		transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
	}

	:global(.textLayer .markedContent) {
		display: contents;
	}

	:global(.textLayer span[role='img']) {
		-webkit-user-select: none;
		-moz-user-select: none;
		user-select: none;
		cursor: default;
	}

	/* Selection highlight color */
	:global(.textLayer ::-moz-selection) {
		background: rgba(0, 0, 255, 0.25);
	}

	:global(.textLayer ::selection) {
		background: rgba(0, 0, 255, 0.25);
	}

	:global(.textLayer br::-moz-selection) {
		background: transparent;
	}

	:global(.textLayer br::selection) {
		background: transparent;
	}

	:global(.textLayer .endOfContent) {
		display: block;
		position: absolute;
		inset: 100% 0 0;
		z-index: 0;
		cursor: default;
		-webkit-user-select: none;
		-moz-user-select: none;
		user-select: none;
	}

	:global(.textLayer.selecting .endOfContent) {
		top: 0;
	}

	/*
	 * Lazy-rendered page placeholders: empty page wrappers get a subtle
	 * background so unrendered pages are still visible while scrolling fast.
	 */
	div :global(.pdf-page-wrapper) {
		background-color: #f9fafb;
	}

	:global(.dark) div :global(.pdf-page-wrapper) {
		background-color: rgb(17 24 39 / 0.35);
	}
</style>
