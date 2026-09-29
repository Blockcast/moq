import { Reader, Writer } from "../stream.ts";

/** The largest message body a peer reads, matching the reader's ceiling and Rust. */
export const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

// Encodes a message with a varint size prefix. A type `id` is written only once the body
// fits, so a message the peer would refuse leaves nothing on the stream.
export async function encode(writer: Writer, f: (w: Writer) => Promise<void>, id?: number) {
	let scratch = new Uint8Array();

	const temp = new Writer(
		new WritableStream({
			write(chunk: Uint8Array) {
				const needed = scratch.byteLength + chunk.byteLength;
				if (needed > scratch.buffer.byteLength) {
					// Resize the buffer to the needed size.
					const capacity = Math.max(needed, scratch.buffer.byteLength * 2);
					const newBuffer = new ArrayBuffer(capacity);
					const newScratch = new Uint8Array(newBuffer, 0, needed);

					// Copy the old data into the new buffer.
					newScratch.set(scratch);

					// Copy the new chunk into the new buffer.
					newScratch.set(chunk, scratch.byteLength);

					scratch = newScratch;
				} else {
					// Copy chunk data into buffer
					scratch = new Uint8Array(scratch.buffer, 0, needed);
					scratch.set(chunk, needed - chunk.byteLength);
				}
			},
		}),
	);

	await f(temp);
	temp.close();
	await temp.closed;

	if (scratch.byteLength > MAX_MESSAGE_SIZE) {
		throw new Error(`message too large: ${scratch.byteLength} bytes (max ${MAX_MESSAGE_SIZE})`);
	}

	if (id !== undefined) await writer.u53(id);
	await writer.u53(scratch.byteLength);
	if (scratch.byteLength > 0) {
		await writer.write(scratch);
	}
}

// Reads a message with a varint size prefix.
export async function decode<T>(reader: Reader, f: (r: Reader) => Promise<T>): Promise<T> {
	const size = await reader.u53();
	const data = await reader.read(size);

	const limit = new Reader(undefined, data);
	const msg = await f(limit);

	// Check that we consumed exactly the right number of bytes
	if (!(await limit.done())) {
		throw new Error("Message decoding consumed too few bytes");
	}

	return msg;
}

export async function decodeMaybe<T>(reader: Reader, f: (r: Reader) => Promise<T>): Promise<T | undefined> {
	if (await reader.done()) return;
	return await decode(reader, f);
}
