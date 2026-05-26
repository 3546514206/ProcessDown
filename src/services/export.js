/**
 * Export Service
 * Handles SVG to PNG conversion on the server side
 * Uses sharp library for image processing
 */

const logger = require('../utils/logger');

let _sharp = null;
let _sharpError = null;

function getSharp() {
    if (_sharp !== null) return _sharp;
    if (_sharpError !== null) throw _sharpError;
    try {
        _sharp = require('sharp');
        return _sharp;
    } catch (err) {
        _sharpError = new Error(
            'sharp module is not available. Please install it for your platform:\n' +
            '  npm install --os=linux --cpu=x64 sharp   (Linux x64)\n' +
            '  npm install --os=win32 --cpu=x64 sharp   (Windows x64)\n' +
            '  npm install sharp                         (current platform)'
        );
        throw _sharpError;
    }
}

class ExportService {
    constructor(config) {
        this.config = config;
    }

    async svgToPng(svgString, scale = 1, bgColor = '#ffffff') {
        const sharp = getSharp();

        return new Promise((resolve, reject) => {
            if (!svgString || typeof svgString !== 'string') {
                reject(new Error('Invalid SVG string'));
                return;
            }

            try {
                let width = 800;
                let height = 600;
                const widthMatch = svgString.match(/width="(\d+)"/);
                const heightMatch = svgString.match(/height="(\d+)"/);
                const viewBoxMatch = svgString.match(/viewBox="0\s+0\s+(\d+)\s+(\d+)"/);

                if (viewBoxMatch) {
                    width = parseInt(viewBoxMatch[1]);
                    height = parseInt(viewBoxMatch[2]);
                } else if (widthMatch && heightMatch) {
                    width = parseInt(widthMatch[1]);
                    height = parseInt(heightMatch[1]);
                }

                width = Math.round(width * scale);
                height = Math.round(height * scale);

                width = Math.max(100, Math.min(width, 8192));
                height = Math.max(100, Math.min(height, 8192));

                let svgWithSize = svgString;
                svgWithSize = svgWithSize.replace(/<svg([^>]*)>/i, (match, attrs) => {
                    if (!attrs.includes('xmlns=')) attrs += ' xmlns="http://www.w3.org/2000/svg"';
                    if (!attrs.includes('width=')) attrs += ` width="${width}"`;
                    else attrs = attrs.replace(/width="[^"]*"/, `width="${width}"`);
                    if (!attrs.includes('height=')) attrs += ` height="${height}"`;
                    else attrs = attrs.replace(/height="[^"]*"/, `height="${height}"`);
                    return `<svg${attrs}>`;
                });

                const buffer = Buffer.from(svgWithSize);

                sharp(buffer, { density: 150 })
                    .resize(width, height, { fit: 'contain', background: bgColor === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : bgColor })
                    .png({ compressionLevel: 9, quality: 100 })
                    .toBuffer()
                    .then(pngBuffer => {
                        logger.debug('PNG generated successfully, size:', pngBuffer.length, 'bytes');
                        resolve(pngBuffer);
                    })
                    .catch(err => {
                        logger.error('Sharp processing error:', err.message);
                        reject(new Error(`Failed to process SVG: ${err.message}`));
                    });

            } catch (error) {
                logger.error('SVG to PNG conversion error:', error.message);
                reject(error);
            }
        });
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