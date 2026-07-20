/**
 * Export Service
 * Converts SVG to PNG using @resvg/resvg-wasm (pure WASM, cross-platform).
 * Loads Source Han Sans SC as the default font so Chinese text renders
 * consistently across macOS / Windows / Linux.
 */

const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');
const logger = require('../utils/logger');

const FONT_PATH = path.join(__dirname, '../../assets/fonts/SourceHanSansSC-Regular.otf');
const WASM_PATH = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
const FONT_FAMILY = 'Source Han Sans SC';

let wasmReady = null;
let fontBuffer = null;

function ensureWasm() {
    if (!wasmReady) {
        wasmReady = (async () => {
            const wasmBuffer = await fs.promises.readFile(WASM_PATH);
            await initWasm(wasmBuffer);
            logger.debug('resvg-wasm initialized');
        })();
        wasmReady.catch(() => {
            wasmReady = null;
        });
    }
    return wasmReady;
}

async function ensureFont() {
    if (!fontBuffer) {
        const raw = await fs.promises.readFile(FONT_PATH);
        fontBuffer = new Uint8Array(raw);
        logger.debug(`Font loaded: ${FONT_PATH}, ${fontBuffer.length} bytes`);
    }
    return fontBuffer;
}

function normalizeFontFamily(svgString) {
    return svgString
        .replace(/font-family\s*=\s*"[^"]*"/gi, `font-family="${FONT_FAMILY}"`)
        .replace(/font-family\s*:\s*[^;"'}]+/gi, `font-family: ${FONT_FAMILY}`);
}

class ExportService {
    async svgToPng(svgString, scale = 1, bgColor = '#ffffff') {
        if (!svgString || typeof svgString !== 'string') {
            throw new Error('Invalid SVG string');
        }

        await ensureWasm();
        const font = await ensureFont();

        const dims = this.extractSvgDimensions(svgString);
        const targetWidth = Math.round(dims.width * scale);
        const targetHeight = Math.round(dims.height * scale);

        if (targetWidth > 8192 || targetHeight > 8192) {
            throw new Error(
                `Output dimensions ${targetWidth}x${targetHeight} exceed 8192px limit ` +
                `(original: ${dims.width}x${dims.height}, scale: ${scale}x). Try a lower scale.`
            );
        }

        const normalizedSvg = normalizeFontFamily(svgString);

        const options = {
            fitTo: { mode: 'zoom', value: scale },
            font: {
                fontBuffers: [font],
                defaultFontFamily: FONT_FAMILY,
                loadSystemFonts: false,
            },
            dpi: Math.min(300, Math.round(150 * scale)),
        };

        if (bgColor !== 'transparent') {
            options.background = bgColor;
        }

        logger.debug(`Exporting PNG: ${targetWidth}x${targetHeight}, dpi: ${options.dpi}`);

        try {
            const resvg = new Resvg(normalizedSvg, options);
            const rendered = resvg.render();
            const pngBytes = rendered.asPng();
            rendered.free();
            const pngBuffer = Buffer.from(pngBytes);
            logger.debug('PNG generated successfully, size:', pngBuffer.length, 'bytes');
            return pngBuffer;
        } catch (err) {
            logger.error('Resvg processing error:', err.message, err.stack);
            const wrapped = new Error(`Failed to process SVG: ${err.message}`);
            wrapped.cause = err;
            throw wrapped;
        }
    }

    extractSvgDimensions(svgString) {
        const vbMatch = svgString.match(/viewBox\s*=\s*"([\d.\-eE]+)\s+([\d.\-eE]+)\s+([\d.]+)\s+([\d.]+)"/);
        if (vbMatch) {
            return { width: parseFloat(vbMatch[3]), height: parseFloat(vbMatch[4]) };
        }

        const svgTagMatch = svgString.match(/<svg[^>]*>/i);
        if (svgTagMatch) {
            const tag = svgTagMatch[0];
            const w = tag.match(/width\s*=\s*"([\d.]+)/);
            const h = tag.match(/height\s*=\s*"([\d.]+)/);
            if (w && h) {
                return { width: parseFloat(w[1]), height: parseFloat(h[1]) };
            }
        }

        return { width: 800, height: 600 };
    }

    parseBackgroundColor(bgType) {
        switch (bgType) {
            case 'dark': return '#1e1e36';
            case 'light': return '#ffffff';
            case 'transparent': return 'transparent';
            default: return '#1e1e36';
        }
    }
}

module.exports = ExportService;
