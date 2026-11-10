// Crop a PNG with nothing but Node's zlib. Tern's `ctl shot` writes the whole window; the drawing
// attachment must contain only the canvas pane, so the crop happens here rather than depending on
// ImageMagick (absent on Windows and most CI images). Only the PNG Tern writes is supported:
// 8-bit RGB or RGBA, non-interlaced. Anything else is refused instead of silently mis-decoded.
import { deflateSync, inflateSync } from "node:zlib";

export interface PngCropRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PngImage {
	width: number;
	height: number;
	/** RGBA, 8 bits per channel. */
	rgba: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Buffer): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** Reads the IHDR width and height without decoding pixels. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
		throw new Error("not a PNG");
	}
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes 8-bit RGB/RGBA non-interlaced PNG into RGBA. */
export function decodePng(bytes: Buffer): PngImage {
	const { width, height } = pngSize(bytes);
	let offset = 8;
	let colorType = -1;
	let bitDepth = 0;
	let interlace = 0;
	const idat: Buffer[] = [];
	while (offset + 8 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			bitDepth = data[8]!;
			colorType = data[9]!;
			interlace = data[12]!;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + length;
	}
	if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
		throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
	}
	const channels = colorType === 6 ? 4 : 3;
	const stride = width * channels;
	const raw = inflateSync(Buffer.concat(idat));
	if (raw.length < height * (stride + 1)) throw new Error("truncated PNG pixel data");
	const rows = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = rows.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? out[i - channels]! : 0;
			const up = prev[i]!;
			const upLeft = i >= channels ? prev[i - channels]! : 0;
			const value = line[i]!;
			out[i] = filter === 0 ? value
				: filter === 1 ? value + left
				: filter === 2 ? value + up
				: filter === 3 ? value + ((left + up) >> 1)
				: filter === 4 ? value + paeth(left, up, upLeft)
				: (() => { throw new Error(`unknown PNG filter ${filter}`); })();
			out[i] &= 0xff;
		}
	}
	if (channels === 4) return { width, height, rgba: rows };
	const rgba = Buffer.alloc(width * height * 4);
	for (let p = 0, q = 0; p < rows.length; p += 3, q += 4) {
		rgba[q] = rows[p]!;
		rgba[q + 1] = rows[p + 1]!;
		rgba[q + 2] = rows[p + 2]!;
		rgba[q + 3] = 255;
	}
	return { width, height, rgba };
}

/** Encodes RGBA as an 8-bit colour-type-6 PNG with filter 0 rows. */
export function encodePng(image: PngImage): Buffer {
	const stride = image.width * 4;
	const raw = Buffer.alloc(image.height * (stride + 1));
	for (let y = 0; y < image.height; y++) {
		raw[y * (stride + 1)] = 0;
		image.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(image.width, 0);
	ihdr.writeUInt32BE(image.height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Crops to `rect`, clamped to the image. Whole-pixel boxes are expected; fractions are rounded. */
export function cropPng(bytes: Buffer, rect: PngCropRect): Buffer {
	const source = decodePng(bytes);
	const x0 = Math.max(0, Math.min(source.width, Math.round(rect.x)));
	const y0 = Math.max(0, Math.min(source.height, Math.round(rect.y)));
	const x1 = Math.max(x0, Math.min(source.width, Math.round(rect.x + rect.w)));
	const y1 = Math.max(y0, Math.min(source.height, Math.round(rect.y + rect.h)));
	const width = x1 - x0;
	const height = y1 - y0;
	if (width < 1 || height < 1) throw new Error("crop rectangle is outside the image");
	const rgba = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		source.rgba.copy(rgba, y * width * 4, ((y0 + y) * source.width + x0) * 4, ((y0 + y) * source.width + x1) * 4);
	}
	return encodePng({ width, height, rgba });
}
