const http = require('http');
const sharp = require('sharp');

async function testDirect() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>';
    const buffer = Buffer.from(svg);
    try {
        const pngBuffer = await sharp(buffer, { density: 150 })
            .resize(100, 100, { fit: 'contain', background: '#1e1e36' })
            .png()
            .toBuffer();
        console.log('Direct sharp OK, PNG size:', pngBuffer.length, 'bytes');
        console.log('Is PNG:', pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50);
    } catch (err) {
        console.log('Direct sharp error:', err.message);
    }
}

async function testViaServer() {
    const data = JSON.stringify({
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
        scale: 1,
        bg: 'dark'
    });

    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3000,
            path: '/api/export/png',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            console.log('Server Status:', res.statusCode);
            let body = [];
            res.on('data', c => body.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(body);
                if (res.statusCode === 200) {
                    console.log('Server PNG OK, size:', buf.length, 'bytes');
                    console.log('Is PNG:', buf[0] === 0x89 && buf[1] === 0x50);
                } else {
                    console.log('Server Error:', buf.toString());
                }
                resolve();
            });
        });
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log('=== Test 1: Direct sharp ===');
    await testDirect();
    console.log('\n=== Test 2: Via server ===');
    await testViaServer();
}

main();
