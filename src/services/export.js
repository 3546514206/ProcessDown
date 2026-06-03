/**
 * Export Service
 * Handles SVG to PNG conversion on the server side
 * Uses sharp library for image processing
 */

const sharp = require('sharp');
const logger = require('../utils/logger');

class ExportService {
    constructor(config) {
        this.config = config;
    }

    async svgToPng(svgString, scale = 1, bgColor = '#ffffff') {
        if (!svgString || typeof svgString !== 'string') {
            throw new Error('Invalid SVG string');
        }

        // Extract dimensions from the root <svg> tag
        const dims = this.extractSvgDimensions(svgString);
        let width = Math.round(dims.width * scale);
        let height = Math.round(dims.height * scale);

        width = Math.max(100, Math.min(width, 8192));
        height = Math.max(100, Math.min(height, 8192));

        // Prepare SVG: ensure correct xmlns, width, height on root tag only
        let svgWithSize = svgString;
        svgWithSize = svgWithSize.replace(/<svg([^>]*)>/i, (match, attrs) => {
            if (!attrs.includes('xmlns=')) attrs += ' xmlns="http://www.w3.org/2000/svg"';
            attrs = attrs.replace(/width\s*=\s*"[^"]*"/, ` width="${width}"`);
            attrs = attrs.replace(/height\s*=\s*"[^"]*"/, ` height="${height}"`);
            if (!attrs.includes('width=')) attrs += ` width="${width}"`;
            if (!attrs.includes('height=')) attrs += ` height="${height}"`;
            return `<svg${attrs}>`;
        });

        const buffer = Buffer.from(svgWithSize);
        const density = Math.min(300, Math.round(150 * scale));

        logger.debug(`Exporting PNG: ${width}x${height}, density: ${density}`);

        try {
            const pngBuffer = await sharp(buffer, { density })
                .resize(width, height, {
                    fit: 'contain',
                    background: bgColor === 'transparent'
                        ? { r: 0, g: 0, b: 0, alpha: 0 }
                        : bgColor
                })
                .png({ compressionLevel: 6 })
                .toBuffer();

            logger.debug('PNG generated successfully, size:', pngBuffer.length, 'bytes');
            return pngBuffer;
        } catch (err) {
            logger.error('Sharp processing error:', err.message);
            throw new Error(`Failed to process SVG: ${err.message}`);
        }
    }

    /**
     * Extract real dimensions from the root <svg> tag.
     * Mermaid outputs viewBox with decimals (e.g. "0 0 1156.5 310")
     * and width/height as "100%" on the root tag, with numeric values
     * on inner elements. We must only read from the root <svg>.
     */
    extractSvgDimensions(svgString) {
        // Prefer viewBox — most reliable for Mermaid SVGs
        const vbMatch = svgString.match(/viewBox\s*=\s*"0\s+0\s+([\d.]+)\s+([\d.]+)"/);
        if (vbMatch) {
            return { width: parseFloat(vbMatch[1]), height: parseFloat(vbMatch[2]) };
        }

        // Fallback: read width/height from the root <svg> tag only
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