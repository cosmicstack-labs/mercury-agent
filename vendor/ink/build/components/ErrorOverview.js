import * as fs from 'node:fs';
import { relative } from 'node:path';
import { cwd } from 'node:process';
import { fileURLToPath } from 'node:url';
import React from 'react';
import StackUtils from 'stack-utils';
import codeExcerpt from 'code-excerpt';
import Box from './Box.js';
import Text from './Text.js';
// Error's source file is reported as file:///home/user/file.js
// This function converts file URLs to paths relative to the current directory
const cleanupPath = (path) => path?.startsWith('file://') ? relative(cwd(), fileURLToPath(path)) : path;
const stackUtils = new StackUtils({
    cwd: cwd(),
    internals: StackUtils.nodeInternals(),
});
export default function ErrorOverview({ error }) {
    const stack = error.stack
        ?.split('\n')
        .slice(error.message.split('\n').length);
    const origin = stack ? stackUtils.parseLine(stack[0]) : undefined;
    const filePath = cleanupPath(origin?.file);
    let excerpt;
    let lineWidth = 0;
    const stackLineCounts = new Map();
    if (filePath !== undefined &&
        filePath !== '' &&
        origin?.line !== undefined &&
        origin.line !== 0) {
        try {
            const sourceCode = fs.readFileSync(filePath, 'utf8');
            excerpt = codeExcerpt(sourceCode, origin.line);
        }
        catch {
            // Source excerpts are best-effort and must not hide the original error.
        }
        if (excerpt) {
            for (const { line } of excerpt) {
                lineWidth = Math.max(lineWidth, String(line).length);
            }
        }
    }
    return (React.createElement(Box, { flexDirection: "column", padding: 1 },
        React.createElement(Box, null,
            React.createElement(Text, { backgroundColor: "red", color: "white" },
                ' ',
                "ERROR",
                ' '),
            React.createElement(Text, null,
                " ",
                error.message)),
        origin && filePath !== undefined && filePath !== '' ? (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { dimColor: true },
                filePath,
                ":",
                origin.line,
                ":",
                origin.column))) : null,
        origin && excerpt ? (React.createElement(Box, { marginTop: 1, flexDirection: "column" }, excerpt.map(({ line, value }) => (React.createElement(Box, { key: line },
            React.createElement(Box, { width: lineWidth + 1 },
                React.createElement(Text, { dimColor: line !== origin.line, backgroundColor: line === origin.line ? 'red' : undefined, color: line === origin.line ? 'white' : undefined, "aria-label": line === origin.line
                        ? `Line ${line}, error`
                        : `Line ${line}` },
                    String(line).padStart(lineWidth, ' '),
                    ":")),
            React.createElement(Text, { key: line, backgroundColor: line === origin.line ? 'red' : undefined, color: line === origin.line ? 'white' : undefined }, ' ' + value)))))) : null,
        stack ? (React.createElement(Box, { marginTop: 1, flexDirection: "column" }, stack.map(line => {
            const parsedLine = stackUtils.parseLine(line);
            const lineCount = stackLineCounts.get(line) ?? 0;
            stackLineCounts.set(line, lineCount + 1);
            const key = `${line}-${lineCount}`;
            // If the line from the stack cannot be parsed, or parsed into an incomplete
            // frame without source location data (for example, "at native"), we print
            // out the unparsed line.
            if (parsedLine?.file === undefined ||
                parsedLine.file === '' ||
                parsedLine.line === undefined ||
                parsedLine.line === 0 ||
                parsedLine.column === undefined ||
                parsedLine.column === 0) {
                return (React.createElement(Box, { key: key },
                    React.createElement(Text, { dimColor: true }, "- "),
                    React.createElement(Text, { dimColor: true, bold: true },
                        line,
                        "\\t",
                        ' ')));
            }
            return (React.createElement(Box, { key: key },
                React.createElement(Text, { dimColor: true }, "- "),
                React.createElement(Text, { dimColor: true, bold: true }, parsedLine.function),
                React.createElement(Text, { dimColor: true, color: "gray", "aria-label": `at ${cleanupPath(parsedLine.file) ?? ''} line ${parsedLine.line} column ${parsedLine.column}` },
                    ' ',
                    "(",
                    cleanupPath(parsedLine.file) ?? '',
                    ":",
                    parsedLine.line,
                    ":",
                    parsedLine.column,
                    ")")));
        }))) : null));
}
