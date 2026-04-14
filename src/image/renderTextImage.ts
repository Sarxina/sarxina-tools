import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";

export interface TextElement {
    text: string;
    x: number;
    y: number;
    fontSize: number;
    /** Overrides TextImageOptions.fontColor. */
    color?: string;
    /** Overrides TextImageOptions.fontFamily. */
    fontFamily?: string;
}

export interface BackgroundRect {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
}

export interface TextImageOptions {
    /** Output PNG width in pixels. */
    width: number;
    /** Output PNG height in pixels. */
    height: number;
    /** Positioned text runs. Each is drawn at (x, y) with dominant-baseline=text-before-edge, which matches Canvas `textBaseline = "top"`. */
    elements: TextElement[];
    /** Default text color applied to any element that doesn't override. Default "#000000". */
    fontColor?: string;
    /** Default font family applied to any element that doesn't override. Default "Arial, sans-serif". */
    fontFamily?: string;
    /** Full-canvas background color. Default "#ffffff" (white). Pass "transparent" for no background — useful when compositing over another image. */
    backgroundColor?: string;
    /** Partial background rectangle. Takes precedence over backgroundColor — if set, the rest of the canvas is transparent. */
    bgRect?: BackgroundRect;
    /** Internal render scale for Pango hinting quality. Default 3. */
    supersample?: number;
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Rasterize positioned text to a PNG buffer. Uses sharp's SVG pipeline
 * (librsvg + Pango + FreeType) with supersampling — this is the "proper
 * hinting" path that produces crisp small text, unlike Skia/@napi-rs/canvas
 * which blurs at 13px and below.
 *
 * Each caller lays out their own text (runs, wrapping, multi-line etc) and
 * hands this function a flat list of positioned elements. The renderer
 * knows nothing about layout — that keeps it small and reusable.
 */
export async function renderTextImage(opts: TextImageOptions): Promise<Buffer> {
    const ss = opts.supersample ?? 3;
    const defaultColor = opts.fontColor ?? "#000000";
    const defaultFamily = opts.fontFamily ?? "Arial, sans-serif";

    const textTags = opts.elements
        .map((el) => {
            const color = el.color ?? defaultColor;
            const family = el.fontFamily ?? defaultFamily;
            return `<text x="${el.x}" y="${el.y}" fill="${color}" font-family="${family}" font-size="${el.fontSize}" dominant-baseline="text-before-edge" xml:space="preserve">${escapeXml(el.text)}</text>`;
        })
        .join("\n");

    // bgRect wins if present (partial fill). Otherwise full-canvas backgroundColor, default white.
    // Pass "transparent" explicitly for no background — SVG handles that natively.
    let bgTag = "";
    if (opts.bgRect) {
        bgTag = `<rect x="${opts.bgRect.x}" y="${opts.bgRect.y}" width="${opts.bgRect.width}" height="${opts.bgRect.height}" fill="${opts.bgRect.color}"/>`;
    } else {
        const bg = opts.backgroundColor ?? "#ffffff";
        bgTag = `<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="${bg}"/>`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" text-rendering="geometricPrecision">
${bgTag}
${textTags}
</svg>`;

    return sharp(Buffer.from(svg), { density: 72 * ss })
        .resize(opts.width, opts.height, { kernel: "lanczos3" })
        .png()
        .toBuffer();
}

/**
 * Measure how wide `text` will be at the given font size + family.
 * Uses @napi-rs/canvas's text metrics — cheap, no render involved.
 *
 * Pango may render slightly different widths than Skia reports here, but
 * in practice they agree within a pixel or two for Latin text, which is
 * close enough for chat-tag layout math.
 */
export function measureText(
    text: string,
    fontSize: number,
    family: string = "Arial, sans-serif"
): number {
    const canvas = createCanvas(1, 1);
    const ctx = canvas.getContext("2d");
    ctx.font = `${fontSize}px ${family}`;
    return ctx.measureText(text).width;
}
