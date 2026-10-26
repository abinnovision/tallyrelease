import { Stream } from "node:stream";
import { styleText } from "node:util";

import type { Writer } from "./writer.js";

export type Format = Parameters<typeof styleText>[0];

export type Paint = (format: Format, text: string) => string;

/** Styles text for `stream`; Node decides on color for real streams, other writers stay plain. */
export const painter = (stream: Writer): Paint =>
	stream instanceof Stream
		? (format, text) =>
				// styleText validates the stream at runtime.
				styleText(format, text, {
					stream: stream as unknown as NodeJS.WritableStream,
				})
		: (_format, text) => text;
