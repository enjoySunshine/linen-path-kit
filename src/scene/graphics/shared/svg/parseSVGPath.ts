import { warn } from '../../../../utils/logging/warn';

import type { GraphicsPath } from '../path/GraphicsPath';

interface SubPath
{
    startX: number;
    startY: number;
}

// char codes used by the scanner
const TAB = 0x09;
const CR = 0x0D;
const SPACE = 0x20;
const PLUS = 0x2B;
const COMMA = 0x2C;
const MINUS = 0x2D;
const DOT = 0x2E;
const ZERO = 0x30;
const NINE = 0x39;
const UPPER_A = 0x41;
const UPPER_E = 0x45;
const UPPER_Z = 0x5A;
const LOWER_A = 0x61;
const LOWER_E = 0x65;
const LOWER_Z = 0x7A;

/**
 * Parses an SVG path data string and builds a GraphicsPath object from the commands.
 * This function handles all standard SVG path commands including moves, lines, curves and arcs.
 * It maintains state for the current position and subpaths to properly handle relative commands
 * and path closures.
 *
 * The string is scanned in a single pass without allocating intermediate command arrays,
 * which keeps parsing fast even for paths with tens of thousands of segments.
 *
 * Supported SVG commands:
 * - M/m: Move to absolute/relative
 * - L/l: Line to absolute/relative
 * - H/h: Horizontal line absolute/relative
 * - V/v: Vertical line absolute/relative
 * - C/c: Cubic bezier curve absolute/relative
 * - S/s: Smooth cubic bezier curve absolute/relative
 * - Q/q: Quadratic bezier curve absolute/relative
 * - T/t: Smooth quadratic bezier curve absolute/relative
 * - A/a: Arc absolute/relative
 * - Z/z: Close path
 * @param svgPath - The SVG path data string to parse (e.g. "M0,0 L100,100")
 * @param path - The GraphicsPath object to build the path into
 * @returns The input path object with the SVG commands applied
 * @internal
 */
export function parseSVGPath(svgPath: string, path: GraphicsPath): GraphicsPath
{
    const length = svgPath.length;

    // Track subpaths for proper path closure handling
    const subpaths: SubPath[] = [];
    let currentSubPath: SubPath | null = null;

    // Track current position for relative commands
    let lastX = 0;
    let lastY = 0;

    // The char code of the command currently being applied. Successive parameter sets
    // repeat the previous command without restating the letter (per the SVG spec)
    let command = 0;

    // Current scan position within the path string
    let i = 0;

    // moveTo/lineTo instructions are pushed directly for speed; moveTo does not mark the
    // path dirty, everything else does (mirroring the GraphicsPath methods)
    const instructions = path.instructions;
    let dirty = false;

    // Skips over whitespace and commas between tokens
    const skipSeparators = (): void =>
    {
        while (i < length)
        {
            const code = svgPath.charCodeAt(i);

            // comma, or whitespace: tab, LF, FF, CR, space
            if (code === COMMA || code === SPACE || (code >= TAB && code <= CR))
            {
                i++;
            }
            else
            {
                break;
            }
        }
    };

    // Reads a single number at the scan position, handling signs,
    // decimals and scientific notation without allocating substrings
    const readNumber = (): number =>
    {
        let code = svgPath.charCodeAt(i);

        // skip separators - a single space is by far the most common case
        if (code === SPACE)
        {
            i++;
            code = svgPath.charCodeAt(i);
        }

        if (code === COMMA || code === SPACE || (code >= TAB && code <= CR))
        {
            skipSeparators();
            code = svgPath.charCodeAt(i);
        }

        let sign = 1;

        if (code === PLUS)
        {
            i++;
        }
        else if (code === MINUS)
        {
            sign = -1;
            i++;
        }

        let value = 0;
        let hasDigits = false;

        // integer part
        while (i < length)
        {
            code = svgPath.charCodeAt(i);
            if (code < ZERO || code > NINE) break;
            value = (value * 10) + (code - ZERO);
            i++;
            hasDigits = true;
        }

        // fractional part - accumulated into the same integer, then scaled down
        if (svgPath.charCodeAt(i) === DOT)
        {
            i++;

            let divisor = 1;

            while (i < length)
            {
                code = svgPath.charCodeAt(i);
                if (code < ZERO || code > NINE) break;
                value = (value * 10) + (code - ZERO);
                divisor *= 10;
                i++;
                hasDigits = true;
            }

            value /= divisor;
        }

        if (!hasDigits)
        {
            throw new Error('malformed path data');
        }

        // exponent, e.g. "1e-3" - only consumed when at least one digit follows
        code = svgPath.charCodeAt(i);

        if (code === LOWER_E || code === UPPER_E)
        {
            let j = i + 1;
            let expSign = 1;

            code = svgPath.charCodeAt(j);

            if (code === MINUS)
            {
                expSign = -1;
                j++;
            }
            else if (code === PLUS)
            {
                j++;
            }

            code = svgPath.charCodeAt(j);

            if (code >= ZERO && code <= NINE)
            {
                let exp = 0;

                while (j < length)
                {
                    code = svgPath.charCodeAt(j);
                    if (code < ZERO || code > NINE) break;
                    exp = (exp * 10) + (code - ZERO);
                    j++;
                }

                value *= 10 ** (expSign * exp);
                i = j;
            }
        }

        return sign * value;
    };

    // Advances the scan position to the next command letter.
    // Used to skip over data that cannot be processed
    const skipToNextCommand = (): void =>
    {
        while (i < length)
        {
            const code = svgPath.charCodeAt(i);

            if ((code >= UPPER_A && code <= UPPER_Z) || (code >= LOWER_A && code <= LOWER_Z)) break;
            i++;
        }
    };

    // Process each command in sequence
    while (i < length)
    {
        let code = svgPath.charCodeAt(i);

        // skip separators - a single space is by far the most common case
        if (code === SPACE)
        {
            i++;
            code = svgPath.charCodeAt(i);
        }

        if (code === COMMA || code === SPACE || (code >= TAB && code <= CR))
        {
            skipSeparators();
            code = svgPath.charCodeAt(i);
        }

        if (i >= length) break;

        if ((code >= UPPER_A && code <= UPPER_Z) || (code >= LOWER_A && code <= LOWER_Z))
        {
            command = code;
            i++;
        }
        else if (command === 0)
        {
            // data found before any command letter - ignore it
            // #if _DEBUG
            warn(`Malformed SVG path data: ${svgPath}`);
            // #endif
            skipToNextCommand();
            continue;
        }

        // close path commands and unknown commands do not start a new subpath
        let shouldTrackSubPath = command !== 90 && command !== 122;

        switch (command)
        {
            case 77: // 'M' - Move To (absolute)
                lastX = readNumber();
                lastY = readNumber();

                instructions.push({ action: 'moveTo', data: [lastX, lastY] });

                // subsequent coordinate pairs are treated as implicit lineTo commands
                command = 76; // 'L'
                break;
            case 109: // 'm' - Move To (relative)
                lastX += readNumber();
                lastY += readNumber();

                instructions.push({ action: 'moveTo', data: [lastX, lastY] });

                // subsequent coordinate pairs are treated as implicit relative lineTo commands
                command = 108; // 'l'
                break;
            case 72: // 'H' - Horizontal Line To (absolute)
                lastX = readNumber();

                instructions.push({ action: 'lineTo', data: [lastX, lastY] });
                dirty = true;
                break;
            case 104: // 'h' - Horizontal Line To (relative)
                lastX += readNumber();

                instructions.push({ action: 'lineTo', data: [lastX, lastY] });
                dirty = true;
                break;
            case 86: // 'V' - Vertical Line To (absolute)
                lastY = readNumber();

                instructions.push({ action: 'lineTo', data: [lastX, lastY] });
                dirty = true;
                break;
            case 118: // 'v' - Vertical Line To (relative)
                lastY += readNumber();

                instructions.push({ action: 'lineTo', data: [lastX, lastY] });
                dirty = true;
                break;
            case 76: // 'L' - Line To (absolute)
                lastX = readNumber();
                lastY = readNumber();

                instructions.push({ action: 'lineTo', data: [lastX, lastY] });
                dirty = true;
                break;
            case 108: // 'l' - Line To (relative)
                lastX += readNumber();
                lastY += readNumber();

                instructions.push({ action: 'lineTo', data: [lastX, lastY] });
                dirty = true;
                break;
            case 67: // 'C' - Cubic Bezier Curve (absolute)
            {
                const cp1x = readNumber();
                const cp1y = readNumber();
                const cp2x = readNumber();
                const cp2y = readNumber();

                lastX = readNumber();
                lastY = readNumber();

                path.bezierCurveTo(
                    cp1x, cp1y, // First control point
                    cp2x, cp2y, // Second control point
                    lastX, lastY // End point
                );
                break;
            }
            case 99: // 'c' - Cubic Bezier Curve (relative)
            {
                const cp1x = readNumber();
                const cp1y = readNumber();
                const cp2x = readNumber();
                const cp2y = readNumber();
                const x = readNumber();
                const y = readNumber();

                path.bezierCurveTo(
                    lastX + cp1x, lastY + cp1y, // First control point
                    lastX + cp2x, lastY + cp2y, // Second control point
                    lastX + x, lastY + y // End point
                );

                lastX += x;
                lastY += y;
                break;
            }
            case 83: // 'S' - Smooth Cubic Bezier Curve (absolute)
            {
                const cp2x = readNumber();
                const cp2y = readNumber();

                lastX = readNumber();
                lastY = readNumber();

                path.bezierCurveToShort(
                    cp2x, cp2y, // Control point
                    lastX, lastY // End point
                );
                break;
            }
            case 115: // 's' - Smooth Cubic Bezier Curve (relative)
            {
                const cp2x = readNumber();
                const cp2y = readNumber();
                const x = readNumber();
                const y = readNumber();

                path.bezierCurveToShort(
                    lastX + cp2x, lastY + cp2y, // Control point
                    lastX + x, lastY + y // End point
                );

                lastX += x;
                lastY += y;
                break;
            }
            case 81: // 'Q' - Quadratic Bezier Curve (absolute)
            {
                const cpx = readNumber();
                const cpy = readNumber();

                lastX = readNumber();
                lastY = readNumber();

                path.quadraticCurveTo(
                    cpx, cpy, // Control point
                    lastX, lastY // End point
                );
                break;
            }
            case 113: // 'q' - Quadratic Bezier Curve (relative)
            {
                const cpx = readNumber();
                const cpy = readNumber();
                const x = readNumber();
                const y = readNumber();

                path.quadraticCurveTo(
                    lastX + cpx, lastY + cpy, // Control point
                    lastX + x, lastY + y // End point
                );

                lastX += x;
                lastY += y;
                break;
            }
            case 84: // 'T' - Smooth Quadratic Bezier Curve (absolute)
                lastX = readNumber();
                lastY = readNumber();

                path.quadraticCurveToShort(
                    lastX, lastY // End point
                );
                break;
            case 116: // 't' - Smooth Quadratic Bezier Curve (relative)
                lastX += readNumber();
                lastY += readNumber();

                path.quadraticCurveToShort(
                    lastX, lastY // End point
                );
                break;
            case 65: // 'A' - Arc (absolute)
            {
                const rx = readNumber();
                const ry = readNumber();
                const xAxisRotation = readNumber();
                const largeArcFlag = readNumber();
                const sweepFlag = readNumber();

                lastX = readNumber();
                lastY = readNumber();

                path.arcToSvg(
                    rx,
                    ry,
                    xAxisRotation,
                    largeArcFlag,
                    sweepFlag,
                    lastX, lastY // End point
                );
                break;
            }
            case 97: // 'a' - Arc (relative)
            {
                const rx = readNumber();
                const ry = readNumber();
                const xAxisRotation = readNumber();
                const largeArcFlag = readNumber();
                const sweepFlag = readNumber();
                const x = readNumber();
                const y = readNumber();

                lastX += x;
                lastY += y;

                path.arcToSvg(
                    rx,
                    ry,
                    xAxisRotation,
                    largeArcFlag,
                    sweepFlag,
                    lastX, lastY // End point
                );
                break;
            }
            case 90: // 'Z' - Close Path
            case 122: // 'z'
                path.closePath();
                if (subpaths.length > 0)
                {
                    // Return to the start of the current subpath
                    currentSubPath = subpaths.pop();
                    if (currentSubPath)
                    {
                        lastX = currentSubPath.startX;
                        lastY = currentSubPath.startY;
                    }
                    else
                    {
                        lastX = 0;
                        lastY = 0;
                    }
                }
                currentSubPath = null;

                // a close path command takes no parameters, so it cannot be repeated implicitly
                command = 0;
                break;
            default:
                // #if _DEBUG
                warn(`Unknown SVG path command: ${String.fromCharCode(command)}`);
                // #endif
                // ignore any parameters belonging to the unknown command
                skipToNextCommand();
                command = 0;
                shouldTrackSubPath = false;
                break;
        }

        // Track subpath starts for path closure
        if (shouldTrackSubPath && currentSubPath === null)
        {
            currentSubPath = { startX: lastX, startY: lastY };
            subpaths.push(currentSubPath);
        }
    }

    if (dirty)
    {
        // mirror the GraphicsPath methods, which mark the path as out of date
        (path as unknown as { _dirty: boolean })._dirty = true;
    }

    return path;
}
