'use strict';

// Edge-case / supplemental tests for fixErdRelationshipLabels (R1 export).
// The developer's happy-path coverage lives in extractor.test.js; this file
// exercises the strict boundaries: quote styles, empty/unsafe labels,
// non-relation false positives, the classDiagram bail-out, mixed diagrams,
// every ERD cardinality, multi-line batching, and the chain order through
// autoFixMermaidCode so the 'Stripped quoted erDiagram relationship labels'
// fix message is emitted at the right step without disturbing other fixers.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { fixErdRelationshipLabels, autoFixMermaidCode } = require('../../src/services/extractor');

describe('fixErdRelationshipLabels - pure-function unit tests', () => {
    it('strips quotes from a safe double-quoted label and keeps the label', () => {
        // SAFE_LABEL = /^[a-zA-Z][a-zA-Z0-9_]*$/ - "isolates" matches.
        const code = 'erDiagram\n    Shipment ||--o{ TemperatureLog : "isolates"';
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        assert.strictEqual(
            result.code,
            'erDiagram\n    Shipment ||--o{ TemperatureLog : isolates'
        );
    });

    it('drops the entire label clause for an unsafe double-quoted label (spaces + parens)', () => {
        // "signs (polymorphic)" is unsafe - space + parens fail SAFE_LABEL.
        const code = 'erDiagram\n    Party ||--o{ Agreement : "signs (polymorphic)"';
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        assert.strictEqual(
            result.code,
            'erDiagram\n    Party ||--o{ Agreement'
        );
    });

    it('strips quotes from a safe single-quoted label and keeps the label', () => {
        const code = "erDiagram\n    Container ||--o{ Item : 'isolates'";
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        assert.strictEqual(
            result.code,
            'erDiagram\n    Container ||--o{ Item : isolates'
        );
    });

    it('drops the entire label clause for an empty double-quoted label', () => {
        // SAFE_LABEL requires a leading letter; "" has none -> not safe.
        const code = 'erDiagram\n    Shipment ||--o{ TemperatureLog : ""';
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        assert.strictEqual(
            result.code,
            'erDiagram\n    Shipment ||--o{ TemperatureLog'
        );
    });

    it('drops the entire label clause for an empty single-quoted label', () => {
        const code = "erDiagram\n    Shipment ||--o{ TemperatureLog : ''";
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        assert.strictEqual(
            result.code,
            'erDiagram\n    Shipment ||--o{ TemperatureLog'
        );
    });

    it('leaves an already-unquoted label unchanged and reports fixed=false', () => {
        // Already-correct form: no quotes, identifier-shaped label - must
        // not be touched and must not be reported as a fix.
        const code = 'erDiagram\n    Shipment ||--o{ TemperatureLog : monitors';
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, false);
        assert.strictEqual(result.code, code);
    });

    it('leaves a relation line without any label unchanged and reports fixed=false', () => {
        const code = 'erDiagram\n    Shipment ||--o{ TemperatureLog';
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, false);
        assert.strictEqual(result.code, code);
    });

    it('does not touch quote-like text on a non-relation line (false-positive defense)', () => {
        // ERD_RELATION_REGEX requires a cardinality pair joined by -- or ..
        // so an attribute declaration carrying "isolates" inside an entity
        // block must NOT be rewritten.
        const code = [
            'erDiagram',
            '    SHIPMENT {',
            '        string note "isolates"',
            '        int id',
            '    }'
        ].join('\n');
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, false);
        assert.strictEqual(result.code, code);
    });

    it('returns the code untouched when no erDiagram declaration is present (classDiagram bail-out)', () => {
        // classDiagram's "1" / "*" cardinality markers and the "isolates"
        // label are NOT erDiagram syntax - the top-level bail-out must skip
        // even the regex pass so classDiagram code is preserved verbatim.
        const code = [
            'classDiagram',
            '    Shipment "1" --> "*" TemperatureLog : "isolates"'
        ].join('\n');
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, false);
        assert.strictEqual(result.code, code);
    });

    it('fixes only the erDiagram relation when both erDiagram and classDiagram coexist', () => {
        // The classDiagram line uses *-- which does not match the ERD
        // relation regex, so it must be left alone even though quotes
        // appear there too.
        const code = [
            'erDiagram',
            '    Shipment ||--o{ TemperatureLog : "isolates"',
            'classDiagram',
            '    Shipment "1" --> "*" TemperatureLog : "isolates"'
        ].join('\n');
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        const lines = result.code.split('\n');
        assert.strictEqual(lines[1], '    Shipment ||--o{ TemperatureLog : isolates');
        // classDiagram line kept verbatim - quoted cardinality + label intact
        assert.strictEqual(
            lines[3],
            '    Shipment "1" --> "*" TemperatureLog : "isolates"'
        );
    });

    it('detects every ERD cardinality on solid and dashed lines (||, }o, }|, o|, o{, |{, }o..o{)', () => {
        // Each variant must trip ERD_RELATION_REGEX (which accepts [-.]+
        // between the two cardinalities) and have its quoted label stripped.
        // Dashed `}o..o{` is Mermaid's "identifying" relation and is the
        // exact pair the design doc calls out.
        const cases = [
            ['||', 'A ||--|| B : "x"'],
            ['}o', 'A }o--}o B : "x"'],
            ['}|', 'A }|--}| B : "x"'],
            ['o|', 'A o|--o| B : "x"'],
            ['o{', 'A o{--o{ B : "x"'],
            ['|{', 'A |{--|{ B : "x"'],
            ['}o..o{', 'A }o..o{ B : "x"']
        ];
        for (const [card, line] of cases) {
            const code = 'erDiagram\n    ' + line;
            const result = fixErdRelationshipLabels(code);

            assert.strictEqual(
                result.fixed,
                true,
                `cardinality ${card} should trigger a fix`
            );
            assert.strictEqual(
                result.code,
                'erDiagram\n    ' + line.replace(' : "x"', ' : x'),
                `cardinality ${card} should strip quotes and keep label`
            );
        }
    });

    it('fixes multiple relations in one block independently (safe / unsafe / empty)', () => {
        // Three lines, three outcomes, one call - asserts the per-line map
        // applies each branch without leaking state between iterations.
        const code = [
            'erDiagram',
            '    Shipment ||--o{ TemperatureLog : "safe"',
            '    Party ||--o{ Agreement : "has parens (ugly)"',
            '    Container ||--o{ Item : ""'
        ].join('\n');
        const result = fixErdRelationshipLabels(code);

        assert.strictEqual(result.fixed, true);
        assert.strictEqual(
            result.code,
            [
                'erDiagram',
                '    Shipment ||--o{ TemperatureLog : safe',
                '    Party ||--o{ Agreement',
                '    Container ||--o{ Item'
            ].join('\n')
        );
    });
});

describe('fixErdRelationshipLabels via autoFixMermaidCode - integration', () => {
    it('returns the fixed code and emits the exact fix message for a safe quoted ERD label', () => {
        // autoFixMermaidCode wires fixErdRelationshipLabels last in the
        // chain; for input that needs only this fix the resulting code
        // must match the pure-function output AND the message string
        // must be exactly what other fix branches emit (no phrasing drift).
        const input = 'erDiagram\n    Shipment ||--o{ TemperatureLog : "isolates"';
        const result = autoFixMermaidCode(input);

        assert.strictEqual(
            result.code,
            'erDiagram\n    Shipment ||--o{ TemperatureLog : isolates'
        );
        assert.ok(
            result.fixes.includes('Stripped quoted erDiagram relationship labels'),
            'fixes should include the ERD label strip message'
        );
    });

    it('coexists with emoji + tab + 全角冒号 fixes and applies the ERD fix in chain', () => {
        // Four fixers in one pass: emoji removal, Chinese punctuation -> ASCII,
        // tab -> 4 spaces, and the quoted ERD label. The chain order is
        // emoji -> Chinese punct -> tab -> opt -> erd -> trailing whitespace,
        // so all four (or more) messages must be present and the final code
        // must reflect every step (including the ERD label strip).
        const input = [
            'erDiagram',
            '\tShipment ||--o{ TemperatureLog ："isolates" 🟢'
        ].join('\n');
        const result = autoFixMermaidCode(input);

        // 1. emoji removed
        assert.ok(
            result.fixes.includes('Removed emoji characters'),
            'emoji fix should run'
        );
        // 2. Chinese full-width colon -> ASCII :
        assert.ok(
            result.fixes.includes('Replaced Chinese punctuation with English equivalents'),
            'Chinese punctuation fix should run'
        );
        // 3. tab -> 4 spaces
        assert.ok(
            result.fixes.includes('Replaced tabs with 4 spaces'),
            'tab fix should run'
        );
        // 4. quoted ERD label stripped
        assert.ok(
            result.fixes.includes('Stripped quoted erDiagram relationship labels'),
            'ERD label fix should run'
        );
        // Final code: no emoji, no 全角冒号, leading tab replaced with 4
        // spaces, and the quoted label unquoted (but kept).
        assert.strictEqual(
            result.code,
            'erDiagram\n    Shipment ||--o{ TemperatureLog : isolates'
        );
    });
});