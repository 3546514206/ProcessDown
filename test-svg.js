const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>';

let width = 100;
let height = 100;
width = Math.round(width * 1);
height = Math.round(height * 1);

let svgWithSize = svg;
svgWithSize = svgWithSize.replace(/<svg([^>]*)>/i, (match, attrs) => {
    if (!attrs.includes('xmlns=')) attrs += ' xmlns="http://www.w3.org/2000/svg"';
    if (!attrs.includes('width=')) attrs += ` width="${width}"`;
    else attrs = attrs.replace(/width="[^"]*"/, `width="${width}"`);
    if (!attrs.includes('height=')) attrs += ` height="${height}"`;
    else attrs = attrs.replace(/height="[^"]*"/, `height="${height}"`);
    return `<svg${attrs}>`;
});

console.log('Result:', svgWithSize);
console.log('Has duplicate xmlns?', (svgWithSize.match(/xmlns=/g) || []).length > 1);
