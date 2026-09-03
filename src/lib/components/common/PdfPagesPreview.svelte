<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { loadPdfJs, PDF_DOCUMENT_OPTIONS, acquirePdfDocument } from '$lib/utils/pdf';
	import { findFileKey } from '$lib/utils/fileCache';
	import Spinner from './Spinner.svelte';
	import PDFViewer from './PDFViewer.svelte';

	export let data: ArrayBuffer | Uint8Array | null = null;
	export let currentSlide = 0;
	export let className = '';
	export let targetPage: number | null = null;
	export let singlePage = false;
	export let itemLabel = 'Page';
	export let listLabel = 'Pages';
	/** Stable key derived from the file-cache key (shared doc + render caches). */
	export let cacheKey: string | null = null;

	type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;

	let rootEl: HTMLDivElement;
	let pdfViewerRef: PDFViewer;
	let viewerData: ArrayBuffer | Uint8Array | null = null;
	let pageTarget: number | null = null;
	let thumbsLoading = false;
	let thumbnails: string[] = [];
	let thumbnailButtons: Array<HTMLButtonElement | undefined> = [];
	let hideThumbs = false;
	let resizeObserver: ResizeObserver | null = null;
	let pdfDoc: PdfDocument | null = null;
	let loadToken = 0;
	let asideEl: HTMLElement;
	let resolvedCacheKey = '';
	let releaseThumbDoc: (() => void) | null = null;

	// Lazy thumbnail rendering: placeholder entries are listed immediately and
	// actual thumbnails are rendered only when they scroll near the visible part
	// of the sidebar (important for documents with hundreds of pages).
	let thumbsObserver: IntersectionObserver | null = null;
	let thumbQueue: number[] = [];
	let thumbQueueRunning = false;

	$: safePage = Math.min(Math.max(0, currentSlide), Math.max(0, thumbnails.length - 1));

	const copyPdfData = (pdfData: ArrayBuffer | Uint8Array) =>
		pdfData instanceof Uint8Array ? pdfData.slice() : pdfData.slice(0);

	const updateLayout = () => {
		hideThumbs = (rootEl?.clientWidth ?? window.innerWidth) < 720;
	};

	const trackThumbnail = (node: HTMLButtonElement, index: number) => {
		node.dataset.thumbIndex = String(index);
		thumbnailButtons[index] = node;
		thumbsObserver?.observe(node);
		return {
			destroy: () => {
				if (thumbnailButtons[index] === node) thumbnailButtons[index] = undefined;
				thumbsObserver?.unobserve(node);
			}
		};
	};

	const scrollSelectedThumbnailIntoView = () => {
		if (hideThumbs) return;
		thumbnailButtons[safePage]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	};

	const selectPage = async (index: number) => {
		currentSlide = Math.min(Math.max(0, index), Math.max(0, thumbnails.length - 1));
		pageTarget = currentSlide + 1;
		await tick();
		await pdfViewerRef?.scrollToPage?.(pageTarget);
		scrollSelectedThumbnailIntoView();
	};

	const loadThumbnails = async (pdfData: ArrayBuffer | Uint8Array) => {
		const token = ++loadToken;
		thumbsLoading = true;
		thumbQueue = [];
		thumbsObserver?.disconnect();
		thumbsObserver = null;
		thumbnails = [];

		try {
			const pdfjs = await loadPdfJs();

			if (releaseThumbDoc) {
				releaseThumbDoc();
				releaseThumbDoc = null;
			} else {
				pdfDoc?.destroy();
			}
			pdfDoc = null;

			if (resolvedCacheKey) {
				// Reuse the shared parsed document so thumbnails and viewer do not
				// both parse the same 900+ page file.
				const { doc, release } = await acquirePdfDocument(
					`doc:${resolvedCacheKey}`,
					() => pdfjs.getDocument({ data: pdfData, ...PDF_DOCUMENT_OPTIONS }).promise
				);
				if (token !== loadToken) {
					release();
					return;
				}
				pdfDoc = doc;
				releaseThumbDoc = release;
			} else {
				pdfDoc = await pdfjs.getDocument({ data: pdfData, ...PDF_DOCUMENT_OPTIONS }).promise;
			}
			if (token !== loadToken) return;

			// Placeholder entries only — the actual thumbnails are rendered lazily
			// (see watchThumbnails) when they become visible in the sidebar, so
			// documents with hundreds of pages open instantly.
			thumbnails = Array(pdfDoc.numPages).fill(null);

			await tick();
			if (token !== loadToken) return;

			watchThumbnails();
		} catch (e) {
			console.warn('PDF thumbnail render error:', e);
			if (token === loadToken) thumbnails = [];
		} finally {
			if (token === loadToken) thumbsLoading = false;
		}
	};

	// Observe thumbnail placeholders: render thumbnails for the ones near the
	// visible part of the sidebar, one at a time to keep the UI responsive.
	const watchThumbnails = () => {
		thumbsObserver?.disconnect();

		thumbsObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const index = Number((entry.target as HTMLElement).dataset.thumbIndex);
					if (!Number.isNaN(index)) {
						enqueueThumbnail(index);
					}
				}
			},
			{ root: asideEl, rootMargin: '300% 0px 300% 0px' }
		);

		for (const node of thumbnailButtons) {
			if (node) thumbsObserver.observe(node);
		}
	};

	const renderThumbnail = async (index: number) => {
		if (!pdfDoc || thumbnails[index]) return;
		const token = loadToken;

		const page = await pdfDoc.getPage(index + 1);
		if (token !== loadToken) return;
		const viewport = page.getViewport({ scale: 0.28 });
		const canvas = document.createElement('canvas');
		canvas.width = viewport.width;
		canvas.height = viewport.height;

		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		await page.render({ canvas, canvasContext: ctx, viewport }).promise;
		if (token !== loadToken) return;

		thumbnails[index] = canvas.toDataURL('image/png');
		thumbnails = thumbnails;
	};

	const runThumbQueue = async () => {
		if (thumbQueueRunning) return;
		thumbQueueRunning = true;
		try {
			while (thumbQueue.length > 0) {
				const index = thumbQueue.shift()!;
				try {
					await renderThumbnail(index);
				} catch (e) {
					console.warn('PDF thumbnail render error:', e);
				}
				// Don't starve the main thread while filling the sidebar.
				await new Promise((resolve) => setTimeout(resolve));
			}
		} finally {
			thumbQueueRunning = false;
		}
	};

	const enqueueThumbnail = (index: number, priority = false) => {
		if (index < 0 || index >= thumbnails.length || thumbnails[index]) return;

		const existing = thumbQueue.indexOf(index);
		if (existing !== -1) thumbQueue.splice(existing, 1);
		if (priority) {
			thumbQueue.unshift(index);
		} else {
			thumbQueue.push(index);
		}
		void runThumbQueue();
	};

	$: if (data) {
		viewerData = copyPdfData(data);
		resolvedCacheKey = (cacheKey ?? findFileKey(data)) || '';
		void loadThumbnails(copyPdfData(data));
	} else {
		viewerData = null;
		thumbnails = [];
		resolvedCacheKey = '';
	}

	$: if (targetPage) {
		currentSlide = Math.max(0, targetPage - 1);
		pageTarget = targetPage;
		// Render the requested page's thumbnail with priority
		enqueueThumbnail(targetPage - 1, true);
	}

	$: if (thumbnails.length > 0) {
		void tick().then(scrollSelectedThumbnailIntoView);
	}

	export const resetView = () => {
		pdfViewerRef?.resetView();
	};

	const handlePageChange = (page: number) => {
		currentSlide = page - 1;
		if (singlePage) pageTarget = page;
		void tick().then(scrollSelectedThumbnailIntoView);
	};

	onMount(() => {
		resizeObserver = new ResizeObserver(updateLayout);
		if (rootEl) resizeObserver.observe(rootEl);
		updateLayout();
	});

	onDestroy(() => {
		loadToken++;
		resizeObserver?.disconnect();
		thumbsObserver?.disconnect();
		thumbQueue = [];
		if (releaseThumbDoc) {
			releaseThumbDoc();
			releaseThumbDoc = null;
		} else {
			pdfDoc?.destroy();
		}
	});
</script>

<div
	bind:this={rootEl}
	class="relative grid {hideThumbs
		? 'grid-cols-[minmax(0,1fr)]'
		: 'grid-cols-[144px_minmax(0,1fr)]'} min-h-0 bg-transparent text-gray-900 dark:text-gray-100 {className}"
>
	<aside
		bind:this={asideEl}
		class={hideThumbs
			? 'hidden'
			: 'thumbnail-sidebar overflow-y-auto px-2 pt-3 pb-16 border-r border-gray-50 dark:border-gray-850/30 bg-transparent'}
		aria-label={listLabel}
	>
		{#if thumbsLoading && thumbnails.length === 0}
			<div class="flex h-full items-center justify-center">
				<Spinner className="size-4" />
			</div>
		{:else}
			{#each thumbnails as thumbnail, index}
				<button
					use:trackThumbnail={index}
					type="button"
					class="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 w-full mb-3 p-0 text-left text-gray-900 dark:text-gray-100"
					on:click={() => selectPage(index)}
					aria-label="{itemLabel} {index + 1}"
					aria-current={safePage === index ? 'true' : undefined}
				>
					<span
						class="pt-1.5 text-[0.6875rem] font-medium text-right {safePage === index
							? 'text-gray-400 dark:text-gray-500'
							: 'text-gray-300/70 dark:text-gray-700'}">{index + 1}</span
					>
					<span
						class="block overflow-hidden rounded-md bg-transparent {safePage === index
							? 'opacity-100'
							: 'opacity-55 hover:opacity-80'}"
					>
						{#if thumbnail}
							<img
								src={thumbnail}
								alt="{itemLabel} {index + 1} thumbnail"
								class="block w-full h-full object-contain"
								draggable="false"
							/>
						{:else}
							<div
								class="aspect-[0.707] w-full animate-pulse rounded-md bg-gray-100 dark:bg-gray-800"
							></div>
						{/if}
					</span>
				</button>
			{/each}
		{/if}
	</aside>

	<section class="min-w-0 min-h-0 overflow-hidden">
		{#if viewerData}
			<PDFViewer
				bind:this={pdfViewerRef}
				data={viewerData}
				cacheKey={resolvedCacheKey}
				targetPage={pageTarget}
				{singlePage}
				{itemLabel}
				onPageChange={handlePageChange}
				className="w-full h-full"
			/>
		{:else}
			<div class="flex h-full items-center justify-center">
				<Spinner className="size-5" />
			</div>
		{/if}
	</section>
</div>

<style>
	.thumbnail-sidebar {
		scrollbar-color: transparent transparent;
	}

	.thumbnail-sidebar:hover,
	.thumbnail-sidebar:focus,
	.thumbnail-sidebar:focus-within,
	.thumbnail-sidebar:active {
		scrollbar-color: rgba(215, 215, 215, 0.6) transparent;
	}

	:global(.dark) .thumbnail-sidebar:hover,
	:global(.dark) .thumbnail-sidebar:focus,
	:global(.dark) .thumbnail-sidebar:focus-within,
	:global(.dark) .thumbnail-sidebar:active {
		scrollbar-color: rgba(67, 67, 67, 0.6) transparent;
	}

	.thumbnail-sidebar::-webkit-scrollbar-thumb {
		visibility: hidden;
	}

	.thumbnail-sidebar:hover::-webkit-scrollbar-thumb,
	.thumbnail-sidebar:focus::-webkit-scrollbar-thumb,
	.thumbnail-sidebar:focus-within::-webkit-scrollbar-thumb,
	.thumbnail-sidebar:active::-webkit-scrollbar-thumb {
		visibility: visible;
	}

	.thumbnail-sidebar::-webkit-scrollbar-corner {
		display: none;
	}
</style>
