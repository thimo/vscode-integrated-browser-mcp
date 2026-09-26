/**
 * Zoom compensation for `/emulate`. Pure, no `vscode` import, so
 * `tests/unit.mjs` can pin the arithmetic to the numbers from issue #22.
 *
 * When the integrated browser (or the VS Code window) is zoomed, Chromium
 * applies `Emulation.setDeviceMetricsOverride` in *device* pixels, so a
 * request for 1440 CSS px at 125% zoom lands as 1152 CSS px with
 * `devicePixelRatio` 1.25 — the requested `deviceScaleFactor` multiplied by
 * the zoom factor. That product is also how we detect the zoom: it is the
 * only observable that moves with it.
 */

export interface MetricsRequest {
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
}

export interface MetricsProbe {
	innerWidth: number;
	devicePixelRatio: number;
}

/**
 * The zoom factor that explains a probe, or undefined when zoom is not what
 * went wrong (the width was dropped outright, the probe is degenerate).
 * Requires both signals to agree — `devicePixelRatio / deviceScaleFactor`
 * and `width / innerWidth` — so an unrelated mismatch does not get "fixed"
 * by scaling everything by a wrong number.
 */
export function detectZoom(requested: Pick<MetricsRequest, 'width' | 'deviceScaleFactor'>, probe: MetricsProbe): number | undefined {
	if (probe.innerWidth === requested.width) return undefined;
	if (!(probe.innerWidth > 0) || !(requested.deviceScaleFactor > 0)) return undefined;
	const zoom = probe.devicePixelRatio / requested.deviceScaleFactor;
	if (!Number.isFinite(zoom) || zoom <= 0 || Math.abs(zoom - 1) < 1e-6) return undefined;
	// Chromium reports innerWidth as an integer, so allow the rounding it did.
	if (Math.abs(probe.innerWidth * zoom - requested.width) >= 1) return undefined;
	return zoom;
}

/** The override to send so the page sees the *requested* CSS px and DPR under `zoom`. */
export function compensateForZoom(requested: MetricsRequest, zoom: number): MetricsRequest {
	return {
		width: Math.round(requested.width * zoom),
		height: Math.round(requested.height * zoom),
		deviceScaleFactor: requested.deviceScaleFactor / zoom,
		mobile: requested.mobile,
	};
}
