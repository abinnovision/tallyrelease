export interface Writer {
	write: (chunk: string) => unknown;
}
